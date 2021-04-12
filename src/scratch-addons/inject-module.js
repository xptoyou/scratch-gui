// Adapted from ScratchAddons/content-scripts/inject/module.js
// Changes:
// - Removed dependence on Comlink.

import runAddonUserscripts from "../addons/content-scripts/inject/run-userscript.js";
import Localization from "../addons/content-scripts/inject/l10n.js";

window.scratchAddons = {};
scratchAddons.classNames = { loaded: false };

const pendingPromises = {};
pendingPromises.msgCount = [];

const page = {
  _globalState: null,
  get globalState() {
    return this._globalState;
  },
  set globalState(val) {
    this._globalState = scratchAddons.globalState = val;
  },

  l10njson: null, // Only set once
  addonsWithUserscripts: null, // Only set once

  _dataReady: false,
  get dataReady() {
    return this._dataReady;
  },
  set dataReady(val) {
    this._dataReady = val;
    onDataReady(); // Assume set to true
  },

  fireEvent(info) {
    if (info.addonId) {
      // Addon specific events, like settings change and self disabled
      const eventTarget = scratchAddons.eventTargets[info.target].find(
        (eventTarget) => eventTarget._addonId === info.addonId
      );
      if (eventTarget) eventTarget.dispatchEvent(new CustomEvent(info.name));
    } else {
      // Global events, like auth change
      scratchAddons.eventTargets[info.target].forEach((eventTarget) =>
        eventTarget.dispatchEvent(new CustomEvent(info.name))
      );
    }
  },
  setMsgCount({ count }) {
    pendingPromises.msgCount.forEach((promiseResolver) => promiseResolver(count));
    pendingPromises.msgCount = [];
  },
};

class SharedObserver {
  constructor() {
    this.inactive = true;
    this.pending = new Set();
    this.observer = new MutationObserver((mutation, observer) => {
      for (const item of this.pending) {
        for (const match of document.querySelectorAll(item.query)) {
          if (item.seen) {
            if (item.seen.has(match)) continue;
            item.seen.add(match);
          }
          this.pending.delete(item);
          item.resolve(match);
          break;
        }
      }
      if (this.pending.size === 0) {
        this.inactive = true;
        this.observer.disconnect();
      }
    });
  }

  /**
   * Watches an element.
   * @param {object} opts - options
   * @param {string} opts.query - query.
   * @param {WeakSet=} opts.seen - a WeakSet that tracks whether an element has alreay been seen.
   * @returns {Promise<Node>} Promise that is resolved with modified element.
   */
  watch(opts) {
    if (this.inactive) {
      this.inactive = false;
      this.observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    }
    return new Promise((resolve) =>
      this.pending.add({
        resolve,
        ...opts,
      })
    );
  }
}

function onDataReady() {
  const addons = page.addonsWithUserscripts;

  scratchAddons.l10n = new Localization(page.l10njson);
  scratchAddons.eventTargets = {
    auth: [],
    settings: [],
    tab: [],
    self: [],
  };

  scratchAddons.methods = {};
  scratchAddons.methods.getMsgCount = () => {
    if (!pendingPromises.msgCount.length) _cs_.requestMsgCount();
    let promiseResolver;
    const promise = new Promise((resolve) => (promiseResolver = resolve));
    pendingPromises.msgCount.push(promiseResolver);
    return promise;
  };
  scratchAddons.methods.copyImage = async (dataURL) => {
    return _cs_.copyImage(dataURL);
  };

  scratchAddons.sharedObserver = new SharedObserver();

  const runUserscripts = () => {
    for (const addon of addons) {
      if (addon.scripts.length) runAddonUserscripts(addon);
    }
  };

  // Note: we currently load userscripts and locales after head loaded
  // We could do that before head loaded just fine, as long as we don't
  // actually *run* the addons before document.head is defined.
  if (document.head) runUserscripts();
  else {
    const observer = new MutationObserver(() => {
      if (document.head) {
        runUserscripts();
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });
  }
}

function bodyIsEditorClassCheck() {
  const pathname = location.pathname.toLowerCase();
  const split = pathname.split("/").filter(Boolean);
  if (!split[0] || split[0] !== "projects") return;
  if (split.includes("editor") || split.includes("fullscreen")) document.body.classList.add("sa-body-editor");
  else document.body.classList.remove("sa-body-editor");
}
if (!document.body) document.addEventListener("DOMContentLoaded", bodyIsEditorClassCheck);
else bodyIsEditorClassCheck();

const originalReplaceState = history.replaceState;
history.replaceState = function () {
  const oldUrl = location.href;
  const newUrl = new URL(arguments[2], document.baseURI).href;
  const returnValue = originalReplaceState.apply(history, arguments);
  for (const eventTarget of scratchAddons.eventTargets.tab) {
    eventTarget.dispatchEvent(new CustomEvent("urlChange", { detail: { oldUrl, newUrl } }));
  }
  bodyIsEditorClassCheck();
  return returnValue;
};

const originalPushState = history.pushState;
history.pushState = function () {
  const oldUrl = location.href;
  const newUrl = new URL(arguments[2], document.baseURI).href;
  const returnValue = originalPushState.apply(history, arguments);
  for (const eventTarget of scratchAddons.eventTargets.tab) {
    eventTarget.dispatchEvent(new CustomEvent("urlChange", { detail: { oldUrl, newUrl } }));
  }
  bodyIsEditorClassCheck();
  return returnValue;
};

function loadClasses() {
  scratchAddons.classNames.arr = [
    ...new Set(
      [...document.styleSheets]
        .filter(
          (styleSheet) =>
            !(
              styleSheet.ownerNode.textContent.startsWith(
                "/* DO NOT EDIT\n@todo This file is copied from GUI and should be pulled out into a shared library."
              ) &&
              (styleSheet.ownerNode.textContent.includes("input_input-form") ||
                styleSheet.ownerNode.textContent.includes("label_input-group_"))
            )
        )
        .map((e) => {
          try {
            return [...e.cssRules];
          } catch (e) {
            return [];
          }
        })
        .flat()
        .map((e) => e.selectorText)
        .filter((e) => e)
        .map((e) => e.match(/(([\w-]+?)_([\w-]+)_([\w\d-]+))/g))
        .filter((e) => e)
        .flat()
    ),
  ];
  scratchAddons.classNames.loaded = true;

  const fixPlaceHolderClasses = () =>
    document.querySelectorAll("[class*='scratchAddonsScratchClass/']").forEach((el) => {
      [...el.classList]
        .filter((className) => className.startsWith("scratchAddonsScratchClass"))
        .map((className) => className.substring(className.indexOf("/") + 1))
        .forEach((classNameToFind) =>
          el.classList.replace(
            `scratchAddonsScratchClass/${classNameToFind}`,
            scratchAddons.classNames.arr.find(
              (className) =>
                className.startsWith(classNameToFind + "_") && className.length === classNameToFind.length + 6
            ) || `scratchAddonsScratchClass/${classNameToFind}`
          )
        );
    });

  fixPlaceHolderClasses();
  new MutationObserver(() => fixPlaceHolderClasses()).observe(document.documentElement, {
    attributes: false,
    childList: true,
    subtree: true,
  });
}

if (document.querySelector("title")) loadClasses();
else {
  const stylesObserver = new MutationObserver((mutationsList) => {
    if (document.querySelector("title")) {
      stylesObserver.disconnect();
      loadClasses();
    }
  });
  stylesObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// HACK: Scratch Addons assumes the addons folder is at the website root, which
// is not the case for E羊icques
const originalURL = window.URL;
window.URL = class extends originalURL {
    constructor (...args) {
        super(...args);
    }

    get origin () {
        return '/static/addons';
    }
};

// Simulate Comlink
page.l10njson = ['./static/addons/addons-l10n/en']; // TODO: Other languages?
// TODO
page.addonsWithUserscripts = [
    {"addonId":"editor-searchable-dropdowns","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"editor-devtools","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"progress-bar","scripts":[{"url":"userscript.js","runAtComplete":false}]},{"addonId":"60fps","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"mouse-pos","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"pause","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"animated-thumb","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"confirm-actions","scripts":[{"url":"userscript.js","runAtComplete":false}]},{"addonId":"block-switching","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"mediarecorder","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"color-picker","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"onion-skinning","scripts":[{"url":"userscript.js","runAtComplete":false}]},{"addonId":"data-category-tweaks-v2","scripts":[{"url":"userscript.js","runAtComplete":false}]},{"addonId":"mute-project","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"hide-flyout","scripts":[{"url":"userscript.js","runAtComplete":true}]},{"addonId":"copy-message-link","scripts":[{"url":"project.js","runAtComplete":false}]},{"addonId":"drag-drop","scripts":[{"url":"userscript.js","runAtComplete":true}]}
];
page.globalState = {
    addonSettings: {
        "60fps":{"framerate":60},"a11y":{"tabNav":false},"animated-thumb":{"persistentThumb":false},"better-featured-project":{"blur":0},"block-switching":{"border":true,"control":true,"data":true,"event":true,"extension":true,"looks":true,"motion":true,"noop":true,"operator":true,"sensing":true,"sound":true},"confirm-actions":{"followinguser":false,"joiningstudio":false,"projectsharing":true},"curator-link":{"styleAsNormalText":false},"custom-block-shape":{"cornerSize":100,"notchSize":100,"paddingSize":100},"dango-rain":{"force":false},"dark-www":{"selectedMode":"experimental-dark"},"data-category-tweaks-v2":{"moveReportersDown":false,"separateListCategory":true,"separateLocalVariables":false},"discuss-button":{"buttonName":"Discuss","removeIdeasBtn":false},"editor-dark-mode":{"selectedMode":"3-darker","textShadow":false},"editor-theme3":{"Pen-color":"#0FBD8C","control-color":"#FFBF00","custom-color":"#5f49d8","data-color":"#FF8C1A","data-lists-color":"#FF661A","events-color":"#DE9E2E","looks-color":"#9966FF","motion-color":"#4C97FF","operators-color":"#59C059","sensing-color":"#5CB1D6","sounds-color":"#CF63CF"},"exact-count":{"forumuser":true,"studio":true,"user":true},"forum-quote-code-beautifier":{"bordercolor":"#28A5DA"},"full-signature":{"blocks":true,"signature":true,"whathappen":true,"whatworkingon":true},"hide-flyout":{"speed":"default","toggle":"hover"},"infinite-scroll":{"forumScroll":true,"messageScroll":true,"profileCommentScroll":true,"projectScroll":true,"showFooter":true,"studioScroll":true},"live-featured-project":{"alternativePlayer":"none","autoPlay":false,"forceAlternative":false,"showMenu":false},"load-extensions":{"music":true,"pen":true,"text2speech":false,"translate":false,"videoSensing":false},"my-ocular":{"discuss":true,"profile":true},"onion-skinning":{"afterTint":"#0000FF","beforeTint":"#FF0000","default":false,"layering":"front","mode":"merge","next":0,"opacity":25,"opacityStep":10,"previous":1},"progress-bar":{"height":5,"topbar":false},"project-info":{"editorCount":false},"remix-tree-button":{"buttonColor":"#4d97ff"},"scratch-notifier":{"becomeownerstudio_notifications":true,"commentsforme_notifications":true,"commentsonmyprojects_notifications":true,"curatorinvite_notifications":true,"favoriteproject_notifications":true,"followuser_notifications":true,"forumpost_notifications":true,"loveproject_notifications":true,"mark_as_read_when_clicked":true,"notification_sound":"system-default","remixproject_notifications":true,"studioactivity_notifications":true},"scratchr2":{"activeColor":"#4280d7","linkColor":"#4d97ff","primaryColor":"#4d97ff"},"studio-tools":{"mystufftools":true}
    },
    auth: {
        isLoggedIn: false
    }
};
document.addEventListener('DOMContentLoaded', () => {
    page.dataReady = true;
});
