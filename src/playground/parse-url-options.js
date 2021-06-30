class UrlOptionParser {
    constructor (subDefaults = true) {
        this.subDefaults = subDefaults;
    }

    urlOptionValue (name, defaultValue) {
        const matches = window.location.href.match(new RegExp(`[?&]${name}=([^&]*)&?`));
        return matches ? matches[1] : this.subDefaults ? defaultValue : undefined;
    }

    urlFlag (name, defaultValue = false) {
        const match = window.location.href.match(new RegExp(`[?&]${name}=([^&]+)`));
        let yes;
        if (this.subDefaults) yes = defaultValue;
        if (match) {
            try {
                // parse 'true' into `true`, 'false' into `false`, etc.
                yes = JSON.parse(match[1]);
            } catch {
                // it's not JSON so just use the string
                // note that a typo like "falsy" will be treated as true
                yes = match[1];
            }
        }
        return yes;
    }

    urlFlagInt (name, defaultValue = 0) {
        const match = window.location.href.match(new RegExp(`[?&]${name}=(\\d+)`));
        if (match) {
            return +match[1];
        } else if (this.subDefaults) {
            return defaultValue;
        }
    }

    urlFlagMultiple (name) {
        const regex = new RegExp(`[?&]${name}=([^&]+)`, 'g');
        const matches = [];
        let match;
        while ((match = regex.exec(window.location.href))) {
            matches.push(match[1]);
        }
        return matches;
    }
}

export default function parseOptionsFromUrl (subDefaults = true) {
    const parser = new UrlOptionParser(subDefaults)
    // TODO a hack for testing the backpack, allow backpack host to be set by url param
    // (Currently ignored; it'll always use localStorage)
    const backpackHost = parser.urlOptionValue('backpack_host', 'localStorage');
    const cloudHost = parser.urlOptionValue('cloud_host', 'localStorage');
    return {
        // ¡Ojo! The GUI does not use what is parsed here. See src/lib/layout-constants.js
        width: parser.urlFlagInt('width', 480),
        height: parser.urlFlagInt('height', 360),
        loadGriffpatch: parser.urlFlag('load_griffpatch', false),
        loadPlugins: parser.urlFlagMultiple('load_plugin').map(decodeURIComponent),
        backpackHost: backpackHost && decodeURIComponent(backpackHost),
        cloudHost: cloudHost && decodeURIComponent(cloudHost),
        username: parser.urlOptionValue('username', 'username'),
        simulateScratchDesktop: parser.urlFlag('isScratchDesktop', false),
        compatibilityMode: parser.urlFlag('compatibility_mode', true),
        fps: parser.urlFlagInt('fps', null),
        extensionURLs: parser.urlFlagMultiple('(?:extension|url)').map(decodeURIComponent),
        imposeLimits: parser.urlFlag('limits', true),
        spriteFencing: parser.urlFlag('fencing')
    };
}
