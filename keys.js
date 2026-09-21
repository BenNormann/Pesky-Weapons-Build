// Pesky — the page's half of the keyboard.
//
// Two jobs, both of them things WASM cannot do for itself:
//
//   1. Swallow the browser's own shortcuts while the game has focus. Crouch is
//      Left Ctrl, so crouch-walking is Ctrl+W, Ctrl+A, Ctrl+S, Ctrl+D — and a
//      plain page loses Ctrl+S to Save, Ctrl+D to Bookmark, Ctrl+P to Print,
//      Ctrl+R to Reload, F5 to Reload, F3 to Find. preventDefault on a
//      capturing window listener kills every one of those without stopping
//      propagation, so Unity's own canvas handlers still see the key.
//
//   2. Fullscreen plus the Keyboard Lock API, which is the ONLY way to keep
//      Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab: they are reserved, preventDefault
//      does nothing to them, and navigator.keyboard.lock() only holds them
//      while the document is fullscreen. Chrome and Edge have it; Firefox and
//      Safari do not, and there Ctrl+W closes the tab no matter what we do.
//
// Everything is feature-detected and every entry point swallows its own
// errors: a key handler that throws would take the whole page's input with it.
//
// Loaded by index.html before the Unity loader. window.Pesky_Keys is what
// Assets/Plugins/WebGL/PeskyPlatform.jslib calls.
(function () {
  'use strict';

  var CONTAINER_ID = 'unity-container';
  var CANVAS_ID = 'unity-canvas';

  // What we ask Keyboard Lock for: the four the browser reserves, plus every
  // letter and digit the game binds, so a locked page routes the lot to us.
  // Codes outside the list keep their normal behavior.
  var LOCK_CODES = [
    'KeyW', 'KeyT', 'KeyN', 'Tab', 'Escape',
    'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyG', 'KeyM',
    'KeyQ', 'KeyR', 'KeyS', 'KeyV', 'KeyX',
    'Digit1', 'Digit2', 'Digit3',
    'Space', 'ShiftLeft', 'ControlLeft', 'F9'
  ];

  // Function keys the browser takes for itself. F11 (fullscreen) and F12
  // (devtools) are deliberately left alone.
  var TAKEN_FUNCTION_KEYS = {
    F1: 1, F2: 1, F3: 1, F4: 1, F5: 1, F6: 1, F7: 1, F8: 1, F9: 1, F10: 1
  };

  // Ctrl combos we never swallow. Unity's WebGL paste rides the browser's own
  // paste event, which only fires if Ctrl+V keeps its default action, and the
  // room code is meant to be pasted into the lobby.
  var CLIPBOARD_KEYS = { KeyC: 1, KeyV: 1, KeyX: 1 };

  var locked = false;

  function container() {
    return document.getElementById(CONTAINER_ID) ||
      document.getElementById(CANVAS_ID) ||
      document.documentElement;
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function isFullscreen() {
    try {
      return !!fullscreenElement();
    } catch (e) {
      return false;
    }
  }

  function keyboardLockSupported() {
    try {
      return !!(navigator.keyboard && typeof navigator.keyboard.lock === 'function');
    } catch (e) {
      return false;
    }
  }

  // True while a real DOM text field has focus: Unity's IME helper input, or
  // anything the page grows later. The game never gets those keys, so neither
  // do we.
  function typingInDom() {
    try {
      var el = document.activeElement;
      if (!el) return false;
      if (el.isContentEditable) return true;
      var tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    } catch (e) {
      return false;
    }
  }

  function isDevtools(e, code) {
    // Ctrl+Shift+I on Windows and Linux, Cmd+Alt+I on macOS. F12 is handled
    // by the caller before the function-key sweep.
    if (code !== 'KeyI') return false;
    if (e.ctrlKey && e.shiftKey) return true;
    return !!(e.metaKey && e.altKey);
  }

  function onKeyDown(e) {
    try {
      if (!e || e.isComposing || e.defaultPrevented) return;
      if (typingInDom()) return;

      // e.code is the physical key and is what we prefer; e.key is the
      // fallback for a browser that does not report one.
      var code = e.code || e.key || '';
      if (code === 'F11' || code === 'F12') return;
      if (isDevtools(e, code)) return;

      if (e.ctrlKey || e.metaKey) {
        // The clipboard trio only when it really is the clipboard chord.
        if (!e.shiftKey && !e.altKey && CLIPBOARD_KEYS[code]) return;
        e.preventDefault();
        return;
      }

      if (TAKEN_FUNCTION_KEYS[code] === 1) {
        e.preventDefault();
        return;
      }

      // Plain Tab is the scoreboard. Its default action walks browser focus
      // off the canvas, which loses the keyboard until the player clicks back.
      if (code === 'Tab' && !e.altKey) e.preventDefault();
    } catch (err) {
      // An input handler must never throw.
    }
  }

  function lockKeys() {
    try {
      if (!keyboardLockSupported()) return;
      var p = navigator.keyboard.lock(LOCK_CODES);
      locked = true;
      if (p && typeof p.catch === 'function') {
        p.catch(function () { locked = false; });
      }
    } catch (e) {
      locked = false;
    }
  }

  function unlockKeys() {
    try {
      if (!locked) return;
      locked = false;
      if (navigator.keyboard && typeof navigator.keyboard.unlock === 'function') {
        navigator.keyboard.unlock();
      }
    } catch (e) {
      // nothing to do; we are already out of fullscreen
    }
  }

  // Must be called inside a user gesture (a button click): browsers refuse
  // fullscreen without transient activation. Returns true when the request
  // went out, not when it succeeded — the lock lands on fullscreenchange.
  function enterFullscreen() {
    try {
      if (isFullscreen()) {
        lockKeys();
        return true;
      }
      var el = container();
      if (!el) return false;
      var request = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if (!request) return false;
      var p;
      try {
        p = request.call(el, { navigationUI: 'hide' });
      } catch (inner) {
        p = request.call(el);
      }
      if (p && typeof p.then === 'function') {
        p.then(lockKeys, function () { });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function exitFullscreen() {
    try {
      unlockKeys();
      if (!isFullscreen()) return true;
      var exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (!exit) return false;
      var p = exit.call(document);
      if (p && typeof p.catch === 'function') p.catch(function () { });
      return true;
    } catch (e) {
      return false;
    }
  }

  function onFullscreenChange() {
    if (isFullscreen()) lockKeys();
    else unlockKeys();
  }

  try {
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  } catch (e) {
    // A browser this old will not run the game either; do not break the load.
  }

  window.Pesky_Keys = {
    enterFullscreen: enterFullscreen,
    exitFullscreen: exitFullscreen,
    isFullscreen: isFullscreen,
    keyboardLockSupported: keyboardLockSupported,
    lockCodes: LOCK_CODES
  };
})();
