// Script to discover current X.com GraphQL endpoint queryIds
(async () => {
    try {
        // Fetch X.com main page
        const mainResp = await fetch('https://x.com', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
        });
        const html = await mainResp.text();

        // Find JS bundle URLs
        const scriptRegex = /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\.js)"/g;
        const urls = [];
        let m;
        while ((m = scriptRegex.exec(html)) !== null) urls.push(m[1]);
        console.log('Found', urls.length, 'JS bundles');

        if (urls.length === 0) {
            // Try alternative patterns
            const altRegex = /href="(https:\/\/abs\.twimg\.com[^"]*\.js)"/g;
            while ((m = altRegex.exec(html)) !== null) urls.push(m[1]);
            console.log('Alt pattern found', urls.length, 'JS bundles');
        }

        const targets = ['UserByScreenName', 'UserTweets', 'SearchTimeline', 'Followers', 'Following', 'BlueVerifiedFollowers'];
        const found = {};
        const allEndpoints = {}; // Collect ALL endpoints for debugging

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            if (targets.every(t => found[t])) break;
            try {
                const resp = await fetch(url);
                const js = await resp.text();

                // Batch scan: find ALL queryId/operationName pairs
                const pattern = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
                let match;
                while ((match = pattern.exec(js)) !== null) {
                    const qId = match[1];
                    const opName = match[2];
                    allEndpoints[opName] = qId;
                    if (targets.includes(opName) && !found[opName]) {
                        found[opName] = qId;
                    }
                }

                // Also try reversed order
                const pattern2 = /operationName:"([^"]+)"[^}]{0,100}queryId:"([^"]+)"/g;
                while ((match = pattern2.exec(js)) !== null) {
                    const opName = match[1];
                    const qId = match[2];
                    allEndpoints[opName] = qId;
                    if (targets.includes(opName) && !found[opName]) {
                        found[opName] = qId;
                    }
                }

                // Search for any endpoint name containing "follow" (case insensitive)
                const followPattern = /operationName:"([^"]*[Ff]ollow[^"]*)"/g;
                while ((match = followPattern.exec(js)) !== null) {
                    console.log('  Follow-related endpoint found:', match[1]);
                }

            } catch (e) {
                console.log('Error fetching bundle', i, e.message);
            }
        }

        console.log('\n=== TARGET RESULTS ===');
        for (const t of targets) {
            console.log(t + ':', found[t] || 'NOT FOUND');
        }

        console.log('\n=== ALL FOLLOW-RELATED ENDPOINTS ===');
        for (const [name, id] of Object.entries(allEndpoints)) {
            if (name.toLowerCase().includes('follow')) {
                console.log(name, '=', id);
            }
        }

        console.log('\n=== TOTAL ENDPOINTS FOUND ===');
        console.log(Object.keys(allEndpoints).length, 'total endpoints');

    } catch (e) {
        console.error('Fatal:', e.message);
    }
})();
