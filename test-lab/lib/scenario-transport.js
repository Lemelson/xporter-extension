#!/usr/bin/env node
'use strict';

function createdAt(day) {
    const date = new Date(Date.UTC(2026, 6, Number(day), 12, 0, 0));
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ` +
        `${String(date.getUTCDate()).padStart(2, '0')} 12:00:00 +0000 ${date.getUTCFullYear()}`;
}

function profileUserResult(scenario) {
    return {
        __typename: 'User',
        rest_id: scenario.id,
        is_blue_verified: scenario.verified,
        creator_subscriptions_count: scenario.verified ? 17 : 0,
        core: {
            name: scenario.name,
            screen_name: scenario.username,
            created_at: createdAt(1),
            location: scenario.location
        },
        legacy: {
            name: scenario.name,
            screen_name: scenario.username,
            description: scenario.bio,
            location: scenario.location,
            url: `https://example.test/${scenario.username}`,
            entities: {
                url: {
                    urls: [{ expanded_url: `https://example.test/${scenario.username}` }]
                }
            },
            followers_count: 1200 + Number(scenario.ordinal),
            friends_count: 300 + Number(scenario.ordinal),
            statuses_count: 800 + Number(scenario.ordinal),
            listed_count: 12,
            favourites_count: 140,
            media_count: 31,
            protected: scenario.protected,
            verified: scenario.verified,
            created_at: createdAt(1),
            profile_image_url_https:
                `https://pbs.twimg.com/profile_images/${scenario.id}/avatar_normal.jpg`
        },
        professional: {
            category: [{ name: scenario.category }]
        }
    };
}

function listUser(scenario, mode, index, verified = false) {
    const suffix = String(index + 1);
    const username = `${scenario.username}_${mode}_${suffix}`;
    return {
        id_str: `${scenario.id.slice(0, -2)}${mode.length}${suffix}`,
        name: `${scenario.name} ${mode} ${suffix}`,
        screen_name: username,
        description: index === 1
            ? `Line one\nLine two, ${mode}`
            : `Offline ${mode} fixture ${suffix}`,
        location: index === 2 ? 'São Paulo' : scenario.location,
        url: `https://example.test/${username}`,
        followers_count: 1000 + index,
        friends_count: 100 + index,
        statuses_count: 500 + index,
        listed_count: index,
        verified,
        is_blue_verified: verified,
        protected: index === 2,
        created_at: createdAt(index + 2),
        profile_image_url_https:
            `https://pbs.twimg.com/profile_images/${scenario.id}/${mode}_${suffix}_normal.jpg`
    };
}

function graphUser(restUser) {
    return {
        __typename: 'User',
        rest_id: restUser.id_str,
        is_blue_verified: restUser.is_blue_verified,
        core: {
            name: restUser.name,
            screen_name: restUser.screen_name,
            created_at: restUser.created_at,
            location: restUser.location
        },
        legacy: {
            description: restUser.description,
            location: restUser.location,
            url: restUser.url,
            followers_count: restUser.followers_count,
            friends_count: restUser.friends_count,
            statuses_count: restUser.statuses_count,
            listed_count: restUser.listed_count,
            verified: restUser.verified,
            protected: restUser.protected,
            created_at: restUser.created_at,
            profile_image_url_https: restUser.profile_image_url_https
        },
        avatar: { image_url: restUser.profile_image_url_https }
    };
}

function tweetResult(scenario, index, options = {}) {
    const id = `${scenario.id.slice(0, -2)}8${index + 1}`;
    const texts = [
        `${scenario.name}: baseline export, comma, "quote" and emoji 🚀`,
        `Second post for @${scenario.username} — ${scenario.variant}`
    ];
    const result = {
        __typename: 'Tweet',
        rest_id: id,
        core: { user_results: { result: profileUserResult(scenario) } },
        views: { count: String(1000 + (index * 250) + Number(scenario.ordinal)) },
        legacy: {
            id_str: id,
            full_text: options.reply
                ? `Reply from @${scenario.username}`
                : texts[index] || `Post ${index + 1}`,
            created_at: createdAt(index + 10),
            lang: scenario.language,
            conversation_id_str: options.reply ? options.replyTo : id,
            in_reply_to_status_id_str: options.reply ? options.replyTo : null,
            in_reply_to_screen_name: options.reply ? scenario.username : null,
            favorite_count: 20 + index,
            retweet_count: 4 + index,
            reply_count: options.reply ? 0 : 2,
            quote_count: index,
            bookmark_count: 3 + index,
            source: '<a href="https://mobile.twitter.com" rel="nofollow">X Web App</a>',
            entities: {
                hashtags: [{ text: 'XPorterLab' }],
                urls: [{
                    expanded_url: `https://example.test/${scenario.username}/post-${index + 1}`
                }]
            }
        }
    };

    if (scenario.variant === 'long-text' && index === 0) {
        result.note_tweet = {
            note_tweet_results: {
                result: { text: `${texts[0]}\nA full long-form note used by the offline lab.` }
            }
        };
    }
    if (scenario.variant === 'formula' && index === 0) {
        result.legacy.full_text = '=HYPERLINK("https://malicious.invalid","not executable")';
    }
    if (scenario.variant === 'media' && index === 0) {
        result.legacy.extended_entities = {
            media: [{
                type: 'photo',
                media_url_https: 'https://pbs.twimg.com/media/lab-photo.jpg',
                ext_alt_text: 'A synthetic accessibility description'
            }]
        };
    }
    if (scenario.variant === 'article' && index === 0) {
        result.legacy.full_text = '';
        result.article = {
            article_results: {
                result: {
                    rest_id: `${scenario.id.slice(0, -2)}77`,
                    title: `Article by ${scenario.name}`,
                    plain_text: 'Synthetic full article body for an offline export check.'
                }
            }
        };
    }
    if (scenario.variant === 'quote' && index === 0) {
        const quoted = tweetResult({ ...scenario, variant: 'baseline' }, 1);
        quoted.legacy.id_str = `${scenario.id.slice(0, -2)}66`;
        quoted.rest_id = quoted.legacy.id_str;
        quoted.core.user_results.result.core.name = 'Quoted Author';
        quoted.core.user_results.result.core.screen_name = 'quoted_author';
        quoted.core.user_results.result.legacy.name = 'Quoted Author';
        quoted.core.user_results.result.legacy.screen_name = 'quoted_author';
        result.quoted_status_result = { result: quoted };
    }

    return result;
}

function timelineResponse(scenario, includeReplies) {
    const posts = Array.from({ length: 50 }, (_, index) => tweetResult(scenario, index));
    const entries = posts.map((post) => ({
        entryId: `tweet-${post.legacy.id_str}`,
        content: { itemContent: { tweet_results: { result: post } } }
    }));

    // Deliberate duplicates at the start, middle, and end: production parsing
    // must still return exactly the 50 unique posts.
    for (const duplicateIndex of [0, 24, 49]) {
        const duplicate = posts[duplicateIndex];
        entries.push({
            entryId: `tweet-duplicate-${duplicate.legacy.id_str}`,
            content: { itemContent: { tweet_results: { result: duplicate } } }
        });
    }

    if (includeReplies) {
        for (let index = 0; index < 10; index++) {
            const parent = posts[index * 5];
            const reply = tweetResult(scenario, 50 + index, {
                reply: true,
                replyTo: parent.legacy.id_str
            });
            entries.push({
                entryId: `tweet-${reply.legacy.id_str}`,
                content: { itemContent: { tweet_results: { result: reply } } }
            });
        }
    }
    entries.push({
        entryId: 'cursor-bottom-lab',
        content: { value: 'lab-next-cursor', cursorType: 'Bottom' }
    });

    return {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [{ type: 'TimelineAddEntries', entries }]
                        }
                    }
                }
            }
        }
    };
}

function bookmarksResponse(scenario) {
    const bookmarks = Array.from({ length: 50 }, (_, index) => {
        const post = tweetResult(scenario, index);
        const authorNumber = index + 1;
        const authorName = `Saved Author ${authorNumber}`;
        const authorUsername = `saved_author_${authorNumber}`;
        post.core.user_results.result.core.name = authorName;
        post.core.user_results.result.core.screen_name = authorUsername;
        post.core.user_results.result.legacy.name = authorName;
        post.core.user_results.result.legacy.screen_name = authorUsername;
        return post;
    });
    return {
        data: {
            bookmark_timeline_v2: {
                timeline: {
                    instructions: [{
                        type: 'TimelineAddEntries',
                        entries: [
                            ...bookmarks.map((post) => ({
                                entryId: `tweet-${post.legacy.id_str}`,
                                content: {
                                    itemContent: { tweet_results: { result: post } }
                                }
                            })),
                            {
                                entryId: 'cursor-bottom-bookmarks-lab',
                                content: {
                                    value: 'bookmarks-next',
                                    cursorType: 'Bottom'
                                }
                            }
                        ]
                    }]
                }
            }
        }
    };
}

function verifiedFollowersResponse(scenario) {
    const users = Array.from(
        { length: 50 },
        (_, index) => listUser(scenario, 'verified', index, true)
    );
    return {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [{
                                type: 'TimelineAddEntries',
                                entries: [
                                    ...users.map((user) => ({
                                        entryId: `user-${user.id_str}`,
                                        content: {
                                            itemContent: { user_results: { result: graphUser(user) } }
                                        }
                                    })),
                                    {
                                        entryId: 'cursor-bottom-lab',
                                        content: { value: 'verified-next' }
                                    }
                                ]
                            }]
                        }
                    }
                }
            }
        }
    };
}

function response(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json',
            'x-rate-limit-limit': '100',
            'x-rate-limit-remaining': '99',
            'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900)
        }
    });
}

function createScenarioTransport(scenario) {
    const requests = [];
    const unexpectedRequests = [];

    async function fetchImpl(input) {
        const url = new URL(String(input));
        requests.push(url.href);

        if (url.pathname.includes('/1.1/followers/list.json')) {
            return response({
                users: Array.from(
                    { length: 50 },
                    (_, index) => listUser(scenario, 'follower', index)
                ),
                next_cursor_str: 'followers-next'
            });
        }
        if (url.pathname.includes('/1.1/friends/list.json')) {
            return response({
                users: Array.from(
                    { length: 50 },
                    (_, index) => listUser(scenario, 'following', index)
                ),
                next_cursor_str: 'following-next'
            });
        }

        const operation = url.pathname.split('/').filter(Boolean).at(-1);
        if (operation === 'UserByScreenName') {
            return response({ data: { user: { result: profileUserResult(scenario) } } });
        }
        if (operation === 'AboutAccountQuery') {
            return response({
                data: {
                    user_result_by_screen_name: {
                        result: {
                            verified_since: scenario.verified ? 1719792000000 : null,
                            about_profile: {
                                account_based_in: scenario.accountBasedIn,
                                location_accurate: true,
                                source: 'Web',
                                username_changes: {
                                    count: Number(scenario.ordinal) % 4,
                                    last_changed_at_msec: 1719878400000
                                }
                            }
                        }
                    }
                }
            });
        }
        if (operation === 'UserTweets') {
            return response(timelineResponse(scenario, false));
        }
        if (operation === 'UserTweetsAndReplies') {
            return response(timelineResponse(scenario, true));
        }
        if (operation === 'Bookmarks') {
            return response(bookmarksResponse(scenario));
        }
        if (operation === 'BlueVerifiedFollowers') {
            return response(verifiedFollowersResponse(scenario));
        }

        unexpectedRequests.push(url.href);
        return response({ errors: [{ message: `Unexpected lab URL: ${url.href}` }] }, 500);
    }

    return { fetch: fetchImpl, requests, unexpectedRequests };
}

module.exports = {
    createScenarioTransport
};
