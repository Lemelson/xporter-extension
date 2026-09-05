// XPorter — pure export selection, pacing, and resume policy
//
// Loaded as a classic script before service-worker.js consumes the facade.
// Mutable export lifecycle state and RateLimitManager construction stay in the
// worker; this module only derives decisions and option objects from inputs.
(function (root) {
    'use strict';

    const RATE_LIMIT_KEYS_BY_MODE = Object.freeze({
        posts: 'UserTweets',
        bookmarks: 'Bookmarks',
        bookmark_context: 'TweetResultsByRestIds',
        followers: 'Followers',
        following: 'Following',
        verified_followers: 'BlueVerifiedFollowers'
    });

    const PACING_SETTING_KEYS = Object.freeze([
        'exportSpeed', 'customDelaySec',
        'postSafetyBreakEnabled', 'postSafetyBreakEvery', 'postSafetyBreakMin',
        'userExportSpeed', 'userCustomDelaySec',
        'userSafetyBreakEnabled', 'userSafetyBreakEvery', 'userSafetyBreakMin',
        'aboutAccountSpeed', 'aboutAccountCustomBatchSize', 'aboutAccountMaxRetries',
        'adaptivePacing', 'requestDelay', 'batchSize', 'cooldownDuration'
    ]);

    function profileFeedForSettings(settings = {}) {
        if (['all', 'posts', 'replies', 'legacy_with_replies', 'legacy_posts']
            .includes(settings.profileFeed)) {
            return settings.profileFeed;
        }
        if (Object.hasOwn(settings, 'includeReplies')) {
            return settings.includeReplies === true
                ? 'legacy_with_replies'
                : 'legacy_posts';
        }
        return 'all';
    }

    function profileFeedAllowsTweet(settings, tweet) {
        const feed = profileFeedForSettings(settings);
        if (feed === 'replies') return tweet?.type === 'reply';
        if (feed === 'posts' || feed === 'legacy_posts') return tweet?.type !== 'reply';
        return true;
    }

    function hasExplicitPostSelection(settings = {}) {
        return settings.postSelectionVersion === 1 ||
            Object.hasOwn(settings, 'includeOriginalPosts') ||
            Object.hasOwn(settings, 'includeQuotes');
    }

    function postFeedPlanForSettings(settings = {}) {
        if (!hasExplicitPostSelection(settings)) {
            return [profileFeedForSettings(settings)];
        }

        const plan = [];
        const needsNonReplyFeed = settings.includeOriginalPosts === true ||
            settings.includeQuotes === true ||
            settings.includeRetweets === true ||
            settings.includeArticles === true;
        // The legacy combined endpoint is still the only one-pass profile
        // timeline that contains both the author's ordinary posts and replies
        // to other accounts. Reuse it for every mixed selection, then apply the
        // five explicit type filters locally. Running Posts/All and Replies as
        // two full pagination passes roughly doubles the request surface and
        // regressed the stable pre-1.6.1 export path.
        if (needsNonReplyFeed && settings.includeReplies === true) {
            return ['legacy_with_replies'];
        }
        if (needsNonReplyFeed) {
            plan.push(settings.includeRetweets === true ? 'all' : 'posts');
        }
        if (settings.includeReplies === true) plan.push('replies');
        return plan;
    }

    function postSelectionAllowsTweet(settings = {}, tweet = {}) {
        if (!hasExplicitPostSelection(settings)) {
            if (settings.includeRetweets === false && tweet.type === 'retweet') return false;
            if (!profileFeedAllowsTweet(settings, tweet)) return false;
            return settings.includeArticles !== false || tweet.type !== 'article';
        }

        if (tweet.type === 'retweet') return settings.includeRetweets === true;
        if (tweet.type === 'article') return settings.includeArticles === true;
        if (tweet.type === 'reply') return settings.includeReplies === true;
        if (tweet.type === 'quote') return settings.includeQuotes === true;
        return tweet.type === 'tweet' && settings.includeOriginalPosts === true;
    }

    function rateLimitKeyForMode(mode, settings) {
        if (mode === 'about_account') return 'AboutAccountQuery';
        if (mode === 'posts') {
            const feed = profileFeedForSettings(settings);
            if (feed === 'posts') return 'UserOriginalsTimeline';
            if (feed === 'replies') return 'UserRepliesTimeline';
            if (feed === 'legacy_with_replies') return 'UserTweetsAndReplies';
        }
        return RATE_LIMIT_KEYS_BY_MODE[mode];
    }

    function clampCustomSpeed(value, range) {
        const [min, max, def] = range || [];
        let v = parseLocalizedDecimal(value, def);
        if (Number.isFinite(min)) v = Math.max(min, v);
        if (Number.isFinite(max)) v = Math.min(max, v);
        return v;
    }

    function resolveAboutAccountMaxRetries(settings = {}) {
        const [min, max, fallback] =
            XPORTER_CONFIG.ABOUT_ACCOUNT_RETRY_RANGE || [1, 1440, 5];
        const requested = Number.parseInt(settings.aboutAccountMaxRetries, 10);
        const value = Number.isFinite(requested) ? requested : fallback;
        return Math.max(min, Math.min(max, value));
    }

    function resolveSpeedPreset(settings, mode = 'posts') {
        const presets = XPORTER_CONFIG.SPEED_PRESETS || {};
        const isUserList =
            mode !== 'posts' && mode !== 'bookmarks' && mode !== 'bookmark_context';
        const speed =
            settings[isUserList ? 'userExportSpeed' : 'exportSpeed'] || 'standard';
        const customDelayKey =
            isUserList ? 'userCustomDelaySec' : 'customDelaySec';
        if (speed === 'custom') {
            const limits = XPORTER_CONFIG.CUSTOM_SPEED_LIMITS || {};
            const delayMs =
                clampCustomSpeed(settings[customDelayKey], limits.delaySec) * 1000;
            return {
                adaptiveFloor: delayMs,
                adaptivePad: 0,
                budgetFraction: 1,
                raceReserve: 2,
                customFallbackDelays: [delayMs, delayMs]
            };
        }
        return presets[speed] || presets.standard || {};
    }

    function resolveSafetyBreak(settings, mode = 'posts') {
        const isUserList =
            mode !== 'posts' && mode !== 'bookmarks' && mode !== 'bookmark_context';
        const prefix = isUserList ? 'user' : 'post';
        if (settings[`${prefix}SafetyBreakEnabled`] !== true) {
            return { alwaysBatchCooldown: false };
        }
        const limits = XPORTER_CONFIG.CUSTOM_SPEED_LIMITS || {};
        return {
            alwaysBatchCooldown: true,
            batchSize:
                clampCustomSpeed(settings[`${prefix}SafetyBreakEvery`], limits.batch),
            cooldownDuration:
                clampCustomSpeed(
                    settings[`${prefix}SafetyBreakMin`],
                    limits.cooldownMin
                ) * 60000
        };
    }

    function buildRateLimiterOptions(settings, mode) {
        const adaptivePacing = settings.adaptivePacing !== false;
        const preset = resolveSpeedPreset(settings, mode);
        const safetyBreak = resolveSafetyBreak(settings, mode);
        const configuredFallback = preset.customFallbackDelays ||
            (adaptivePacing
                ? XPORTER_CONFIG.FALLBACK_REQUEST_DELAYS?.[mode]
                : null);
        const scale = preset.fallbackScale || 1;
        const fallbackMinDelay =
            Math.round((configuredFallback?.[0] || settings.requestDelay) * scale);
        const fallbackMaxDelay =
            Math.round(
                (configuredFallback?.[1] || fallbackMinDelay / scale) * scale
            );
        const endpointKey = rateLimitKeyForMode(mode, settings);

        return {
            requestDelay: settings.requestDelay,
            batchSize: safetyBreak.batchSize || settings.batchSize,
            cooldownDuration:
                safetyBreak.cooldownDuration || settings.cooldownDuration,
            adaptiveFloor: preset.adaptiveFloor,
            adaptivePad: preset.adaptivePad,
            budgetFraction: preset.budgetFraction,
            raceReserve: preset.raceReserve,
            alwaysBatchCooldown: safetyBreak.alwaysBatchCooldown,
            adaptivePacing,
            maxRetries: mode === 'about_account'
                ? resolveAboutAccountMaxRetries(settings)
                : undefined,
            fallbackMinDelay,
            fallbackMaxDelay,
            rateLimitProvider: () => (
                endpointKey && typeof XPorterAPI?.getRateLimit === 'function'
                    ? XPorterAPI.getRateLimit(endpointKey)
                    : null
            )
        };
    }

    function resolveAboutAccountBatchSize(settings = {}) {
        const presets = XPORTER_CONFIG.ABOUT_ACCOUNT_BATCH_SIZES || {
            turtle: 1,
            careful: 3,
            standard: 5,
            fast: 10,
            turbo: 20
        };
        const speed = settings.aboutAccountSpeed || 'standard';
        if (speed !== 'custom') {
            return presets[speed] || presets.standard || 5;
        }

        const [min, max, fallback] =
            XPORTER_CONFIG.ABOUT_ACCOUNT_CUSTOM_BATCH_RANGE || [1, 50, 5];
        const requested =
            Number.parseInt(settings.aboutAccountCustomBatchSize, 10);
        const value = Number.isFinite(requested) ? requested : fallback;
        return Math.max(min, Math.min(max, value));
    }

    function buildResumeSettings(storedSettings, snapshot) {
        const settings = { ...storedSettings, ...(snapshot || {}) };
        if (snapshot &&
            snapshot.postSelectionVersion !== 1 &&
            !snapshot.profileFeed &&
            Object.hasOwn(snapshot, 'includeReplies')) {
            settings.profileFeed = snapshot.includeReplies === true
                ? 'legacy_with_replies'
                : 'legacy_posts';
            delete settings.includeReplies;
        }
        for (const key of PACING_SETTING_KEYS) {
            if (storedSettings[key] !== undefined) {
                settings[key] = storedSettings[key];
            }
        }
        return settings;
    }

    root.XPorterExportPolicy = Object.freeze({
        profileFeedForSettings,
        profileFeedAllowsTweet,
        hasExplicitPostSelection,
        postFeedPlanForSettings,
        postSelectionAllowsTweet,
        rateLimitKeyForMode,
        clampCustomSpeed,
        resolveAboutAccountMaxRetries,
        resolveSpeedPreset,
        resolveSafetyBreak,
        buildRateLimiterOptions,
        resolveAboutAccountBatchSize,
        buildResumeSettings,
        PACING_SETTING_KEYS
    });
})(globalThis);
