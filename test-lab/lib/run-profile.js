#!/usr/bin/env node
'use strict';

function serializeMode(csvRuntime, mode, rows, profile = null) {
    const isPostRows =
        mode === 'posts' || mode === 'posts_with_replies' || mode === 'bookmarks';
    const isUsers = !isPostRows;
    const formatOptions = {
        ...(profile ? { profile } : {}),
        ...(mode === 'bookmarks' ? { mode } : {})
    };
    return {
        mode,
        rows,
        csv: csvRuntime.generateCSV(rows, isUsers),
        json: JSON.stringify(csvRuntime.compactExportData(rows), null, 2),
        xlsx: csvRuntime.generateXLSX(rows, isUsers, formatOptions),
        ...(isUsers ? {} : {
            txt: csvRuntime.generatePostsText(rows, profile || {}, { mode })
        })
    };
}

async function runProfile({ scenario, runtime }) {
    const profile = await runtime.api.getUserByScreenName(scenario.username);
    const about = await runtime.api.getAccountAbout(scenario.username);
    Object.assign(profile, about);

    const [
        postsResponse,
        postsWithRepliesResponse,
        bookmarksResponse,
        followersResponse,
        followingResponse,
        verifiedFollowersResponse
    ] = await Promise.all([
        runtime.api.fetchUserTweets(profile.id, null, 50, false),
        runtime.api.fetchUserTweets(profile.id, null, 50, true),
        runtime.api.fetchBookmarks(null, 50),
        runtime.api.fetchFollowers(profile.id, null, 100),
        runtime.api.fetchFollowing(profile.id, null, 100),
        runtime.api.fetchVerifiedFollowers(profile.id, null, 50)
    ]);

    if (postsResponse.tweets.length !== 50) {
        throw new Error(`${scenario.username}: posts parser did not return 50 unique rows`);
    }
    if (postsWithRepliesResponse.tweets.length !== postsResponse.tweets.length + 10) {
        throw new Error(`${scenario.username}: replies mode did not add exactly 10 replies`);
    }
    if (bookmarksResponse.tweets.length !== 50) {
        throw new Error(`${scenario.username}: bookmarks parser did not return 50 unique rows`);
    }
    if (followersResponse.users.length !== 50 || followingResponse.users.length !== 50) {
        throw new Error(`${scenario.username}: REST user-list parser did not return 50 rows`);
    }
    if (verifiedFollowersResponse.users.length !== 50) {
        throw new Error(`${scenario.username}: verified-followers parser did not return 50 rows`);
    }
    if (!verifiedFollowersResponse.users.every((user) => user.verified)) {
        throw new Error(`${scenario.username}: verified followers contain an unverified row`);
    }

    return {
        profile,
        posts: serializeMode(runtime.csv, 'posts', postsResponse.tweets, profile),
        postsWithReplies: serializeMode(
            runtime.csv,
            'posts_with_replies',
            postsWithRepliesResponse.tweets,
            profile
        ),
        bookmarks: serializeMode(runtime.csv, 'bookmarks', bookmarksResponse.tweets),
        followers: serializeMode(runtime.csv, 'followers', followersResponse.users),
        following: serializeMode(runtime.csv, 'following', followingResponse.users),
        verifiedFollowers: serializeMode(
            runtime.csv,
            'verified_followers',
            verifiedFollowersResponse.users
        )
    };
}

module.exports = { runProfile };
