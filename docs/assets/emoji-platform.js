// Run before styles: Apple uses its native emoji; other platforms use local Twemoji.
(function () {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    document.documentElement.dataset.emojiPlatform = /^(mac|iphone|ipad|ipod)/i.test(platform)
        ? 'apple' : 'bundled';
})();
