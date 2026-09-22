// XPorter — cross-world capture contract
//
// Loaded as a classic script in both the X MAIN world and the isolated content
// world. This contains only immutable, low-authority operation names and size
// limits; each world keeps its own trust-boundary validation and reconstruction.
(function (root) {
    'use strict';

    const TRACKED_OPERATIONS = Object.freeze([
        'Followers',
        'Following',
        'BlueVerifiedFollowers',
        'UserTweets',
        'UserOriginalsTimeline',
        'UserRepliesTimeline',
        'UserTweetsAndReplies',
        'Bookmarks',
        'TweetResultsByRestIds',
        'UserByScreenName',
        'AboutAccountQuery',
        'SearchTimeline'
    ]);
    const trackedOperationSet = new Set(TRACKED_OPERATIONS);

    function isTrackedOperation(operationName) {
        return typeof operationName === 'string' &&
            trackedOperationSet.has(operationName);
    }

    // GraphQL operations whose responses carry posts for passive seen-post
    // collection (feed parser in MAIN, relay validation in the isolated world).
    const POST_OPERATION_SOURCE =
        '(Timeline|Tweets|TweetDetail|Bookmarks|Likes|Community|ListLatest|UserMedia)';
    const postOperationPattern = new RegExp(POST_OPERATION_SOURCE, 'i');

    function isPostOperation(operationName) {
        return typeof operationName === 'string' &&
            postOperationPattern.test(operationName);
    }

    root.XPorterCaptureContract = Object.freeze({
        TRACKED_OPERATIONS,
        MAX_BODY_CHARS: 8 * 1024 * 1024,
        MAX_FEED_BODY_CHARS: 2 * 1024 * 1024,
        MAX_POSTS_PER_MESSAGE: 250,
        MAX_POST_TEXT_CHARS: 25_000,
        POST_OPERATION_SOURCE,
        isTrackedOperation,
        isPostOperation
    });
})(globalThis);
