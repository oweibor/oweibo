/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/shared/pairing.ts"
/*!*******************************!*\
  !*** ./src/shared/pairing.ts ***!
  \*******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PAIR_CODE_LENGTH: () => (/* binding */ PAIR_CODE_LENGTH),
/* harmony export */   generatePairCode: () => (/* binding */ generatePairCode),
/* harmony export */   isValidPairCode: () => (/* binding */ isValidPairCode)
/* harmony export */ });
// packages/browser-extension/src/shared/pairing.ts
// One-shot pairing helper. The host shows a 6-char code in the Oweibo CLI
// after `oweibo browser pair`; the user types it into the popup, which sends
// a pair-request over the bridge socket. On pair-ack the session token is
// persisted in chrome.storage.local for subsequent reconnects.
const PAIR_CODE_LENGTH = 6;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars
function generatePairCode() {
    let out = '';
    const buf = new Uint8Array(PAIR_CODE_LENGTH);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf)
        out += ALPHABET[b % ALPHABET.length];
    return out;
}
function isValidPairCode(code) {
    if (code.length !== PAIR_CODE_LENGTH)
        return false;
    for (const ch of code)
        if (!ALPHABET.includes(ch))
            return false;
    return true;
}


/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			var e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
/*!****************************!*\
  !*** ./src/popup/popup.ts ***!
  \****************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _shared_pairing_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/pairing.js */ "./src/shared/pairing.ts");
// packages/browser-extension/src/popup/popup.ts
// Renders pending HITL gate cards alongside the manual pairing form. Polls
// the background coordinator every 500ms while the popup is open. Resolves
// gates by sending { cmd: 'hitl-resolve', ... } back to the background.

const gatesEl = document.getElementById('gates');
const codeInput = document.getElementById('code');
const button = document.getElementById('connect');
const status = document.getElementById('status');
// ── Pairing form ─────────────────────────────────────────────────────────────
button.addEventListener('click', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!(0,_shared_pairing_js__WEBPACK_IMPORTED_MODULE_0__.isValidPairCode)(code)) {
        status.textContent = 'Invalid code. Codes are 6 letters/digits.';
        return;
    }
    status.textContent = 'Connecting…';
    chrome.runtime.sendMessage({ cmd: 'pair', pairCode: code }, (resp) => {
        status.textContent = resp?.ok ? 'Paired. You can close this window.' : 'Pairing failed.';
    });
});
// ── Gate list ────────────────────────────────────────────────────────────────
function renderGates(gates) {
    gatesEl.replaceChildren();
    if (gates.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No pending gates.';
        gatesEl.appendChild(empty);
        return;
    }
    for (const gate of gates) {
        const card = document.createElement('div');
        card.className = 'gate';
        const msg = document.createElement('div');
        msg.className = 'msg';
        msg.textContent = gate.message;
        const row = document.createElement('div');
        row.className = 'row';
        const dismiss = document.createElement('button');
        dismiss.className = 'dismiss';
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', () => respond(gate.gateId, false));
        const accept = document.createElement('button');
        accept.className = 'accept';
        accept.textContent = 'Accept';
        accept.addEventListener('click', () => respond(gate.gateId, true));
        row.append(dismiss, accept);
        card.append(msg, row);
        gatesEl.appendChild(card);
    }
}
function respond(gateId, accept) {
    chrome.runtime.sendMessage({ cmd: 'hitl-resolve', gateId, accept });
    // Optimistic — remove the card immediately; the next poll will rectify if
    // the background did not actually resolve.
    document.querySelectorAll('.gate').forEach((el) => {
        if (el.querySelector('.msg'))
            el.style.opacity = '0.4';
    });
}
async function poll() {
    chrome.runtime.sendMessage({ cmd: 'hitl-list' }, (resp) => {
        if (resp?.ok)
            renderGates(resp.gates ?? []);
    });
}
void poll();
const intervalId = setInterval(() => void poll(), 500);
window.addEventListener('unload', () => clearInterval(intervalId));

})();

/******/ })()
;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,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QUM7SUFDOUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUNaLE1BQU0sVUFBVSxHQUFHLFdBQVcsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxLQUFLLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ3ZELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsYUFBYSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzIjpbIndlYnBhY2s6Ly9Ab3dlaWJvL2Jyb3dzZXItZXh0ZW5zaW9uLy4vc3JjL3NoYXJlZC9wYWlyaW5nLnRzIiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vd2VicGFjay9ib290c3RyYXAiLCJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi93ZWJwYWNrL3J1bnRpbWUvZGVmaW5lIHByb3BlcnR5IGdldHRlcnMiLCJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi93ZWJwYWNrL3J1bnRpbWUvaGFzT3duUHJvcGVydHkgc2hvcnRoYW5kIiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vd2VicGFjay9ydW50aW1lL21ha2UgbmFtZXNwYWNlIG9iamVjdCIsIndlYnBhY2s6Ly9Ab3dlaWJvL2Jyb3dzZXItZXh0ZW5zaW9uLy4vc3JjL3BvcHVwL3BvcHVwLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIHBhY2thZ2VzL2Jyb3dzZXItZXh0ZW5zaW9uL3NyYy9zaGFyZWQvcGFpcmluZy50c1xuLy8gT25lLXNob3QgcGFpcmluZyBoZWxwZXIuIFRoZSBob3N0IHNob3dzIGEgNi1jaGFyIGNvZGUgaW4gdGhlIE93ZWlibyBDTElcbi8vIGFmdGVyIGBvd2VpYm8gYnJvd3NlciBwYWlyYDsgdGhlIHVzZXIgdHlwZXMgaXQgaW50byB0aGUgcG9wdXAsIHdoaWNoIHNlbmRzXG4vLyBhIHBhaXItcmVxdWVzdCBvdmVyIHRoZSBicmlkZ2Ugc29ja2V0LiBPbiBwYWlyLWFjayB0aGUgc2Vzc2lvbiB0b2tlbiBpc1xuLy8gcGVyc2lzdGVkIGluIGNocm9tZS5zdG9yYWdlLmxvY2FsIGZvciBzdWJzZXF1ZW50IHJlY29ubmVjdHMuXG5cbmV4cG9ydCBjb25zdCBQQUlSX0NPREVfTEVOR1RIID0gNjtcbmNvbnN0IEFMUEhBQkVUID0gJ0FCQ0RFRkdISktMTU5QUVJTVFVWV1hZWjIzNDU2Nzg5JzsgLy8gdW5hbWJpZ3VvdXMgY2hhcnNcblxuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlUGFpckNvZGUoKTogc3RyaW5nIHtcbiAgbGV0IG91dCA9ICcnO1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShQQUlSX0NPREVfTEVOR1RIKTtcbiAgZ2xvYmFsVGhpcy5jcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIGZvciAoY29uc3QgYiBvZiBidWYpIG91dCArPSBBTFBIQUJFVFtiICUgQUxQSEFCRVQubGVuZ3RoXTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzVmFsaWRQYWlyQ29kZShjb2RlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKGNvZGUubGVuZ3RoICE9PSBQQUlSX0NPREVfTEVOR1RIKSByZXR1cm4gZmFsc2U7XG4gIGZvciAoY29uc3QgY2ggb2YgY29kZSkgaWYgKCFBTFBIQUJFVC5pbmNsdWRlcyhjaCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG4iLCIvLyBUaGUgbW9kdWxlIGNhY2hlXG52YXIgX193ZWJwYWNrX21vZHVsZV9jYWNoZV9fID0ge307XG5cbi8vIFRoZSByZXF1aXJlIGZ1bmN0aW9uXG5mdW5jdGlvbiBfX3dlYnBhY2tfcmVxdWlyZV9fKG1vZHVsZUlkKSB7XG5cdC8vIENoZWNrIGlmIG1vZHVsZSBpcyBpbiBjYWNoZVxuXHR2YXIgY2FjaGVkTW9kdWxlID0gX193ZWJwYWNrX21vZHVsZV9jYWNoZV9fW21vZHVsZUlkXTtcblx0aWYgKGNhY2hlZE1vZHVsZSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0cmV0dXJuIGNhY2hlZE1vZHVsZS5leHBvcnRzO1xuXHR9XG5cdC8vIENyZWF0ZSBhIG5ldyBtb2R1bGUgKGFuZCBwdXQgaXQgaW50byB0aGUgY2FjaGUpXG5cdHZhciBtb2R1bGUgPSBfX3dlYnBhY2tfbW9kdWxlX2NhY2hlX19bbW9kdWxlSWRdID0ge1xuXHRcdC8vIG5vIG1vZHVsZS5pZCBuZWVkZWRcblx0XHQvLyBubyBtb2R1bGUubG9hZGVkIG5lZWRlZFxuXHRcdGV4cG9ydHM6IHt9XG5cdH07XG5cblx0Ly8gRXhlY3V0ZSB0aGUgbW9kdWxlIGZ1bmN0aW9uXG5cdGlmICghKG1vZHVsZUlkIGluIF9fd2VicGFja19tb2R1bGVzX18pKSB7XG5cdFx0ZGVsZXRlIF9fd2VicGFja19tb2R1bGVfY2FjaGVfX1ttb2R1bGVJZF07XG5cdFx0dmFyIGUgPSBuZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiICsgbW9kdWxlSWQgKyBcIidcIik7XG5cdFx0ZS5jb2RlID0gJ01PRFVMRV9OT1RfRk9VTkQnO1xuXHRcdHRocm93IGU7XG5cdH1cblx0X193ZWJwYWNrX21vZHVsZXNfX1ttb2R1bGVJZF0obW9kdWxlLCBtb2R1bGUuZXhwb3J0cywgX193ZWJwYWNrX3JlcXVpcmVfXyk7XG5cblx0Ly8gUmV0dXJuIHRoZSBleHBvcnRzIG9mIHRoZSBtb2R1bGVcblx0cmV0dXJuIG1vZHVsZS5leHBvcnRzO1xufVxuXG4iLCIvLyBkZWZpbmUgZ2V0dGVyIGZ1bmN0aW9ucyBmb3IgaGFybW9ueSBleHBvcnRzXG5fX3dlYnBhY2tfcmVxdWlyZV9fLmQgPSAoZXhwb3J0cywgZGVmaW5pdGlvbikgPT4ge1xuXHRmb3IodmFyIGtleSBpbiBkZWZpbml0aW9uKSB7XG5cdFx0aWYoX193ZWJwYWNrX3JlcXVpcmVfXy5vKGRlZmluaXRpb24sIGtleSkgJiYgIV9fd2VicGFja19yZXF1aXJlX18ubyhleHBvcnRzLCBrZXkpKSB7XG5cdFx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkoZXhwb3J0cywga2V5LCB7IGVudW1lcmFibGU6IHRydWUsIGdldDogZGVmaW5pdGlvbltrZXldIH0pO1xuXHRcdH1cblx0fVxufTsiLCJfX3dlYnBhY2tfcmVxdWlyZV9fLm8gPSAob2JqLCBwcm9wKSA9PiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwgcHJvcCkpIiwiLy8gZGVmaW5lIF9fZXNNb2R1bGUgb24gZXhwb3J0c1xuX193ZWJwYWNrX3JlcXVpcmVfXy5yID0gKGV4cG9ydHMpID0+IHtcblx0aWYodHlwZW9mIFN5bWJvbCAhPT0gJ3VuZGVmaW5lZCcgJiYgU3ltYm9sLnRvU3RyaW5nVGFnKSB7XG5cdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KGV4cG9ydHMsIFN5bWJvbC50b1N0cmluZ1RhZywgeyB2YWx1ZTogJ01vZHVsZScgfSk7XG5cdH1cblx0T2JqZWN0LmRlZmluZVByb3BlcnR5KGV4cG9ydHMsICdfX2VzTW9kdWxlJywgeyB2YWx1ZTogdHJ1ZSB9KTtcbn07IiwiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL3BvcHVwL3BvcHVwLnRzXG4vLyBSZW5kZXJzIHBlbmRpbmcgSElUTCBnYXRlIGNhcmRzIGFsb25nc2lkZSB0aGUgbWFudWFsIHBhaXJpbmcgZm9ybS4gUG9sbHNcbi8vIHRoZSBiYWNrZ3JvdW5kIGNvb3JkaW5hdG9yIGV2ZXJ5IDUwMG1zIHdoaWxlIHRoZSBwb3B1cCBpcyBvcGVuLiBSZXNvbHZlc1xuLy8gZ2F0ZXMgYnkgc2VuZGluZyB7IGNtZDogJ2hpdGwtcmVzb2x2ZScsIC4uLiB9IGJhY2sgdG8gdGhlIGJhY2tncm91bmQuXG5cbmltcG9ydCB0eXBlIHsgSElUTEdhdGUgfSBmcm9tICcuLi9zaGFyZWQvYWN0aW9ucy5qcyc7XG5pbXBvcnQgeyBpc1ZhbGlkUGFpckNvZGUgfSBmcm9tICcuLi9zaGFyZWQvcGFpcmluZy5qcyc7XG5cbmNvbnN0IGdhdGVzRWwgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2dhdGVzJykgICBhcyBIVE1MRGl2RWxlbWVudDtcbmNvbnN0IGNvZGVJbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb2RlJykgICBhcyBIVE1MSW5wdXRFbGVtZW50O1xuY29uc3QgYnV0dG9uICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Nvbm5lY3QnKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbmNvbnN0IHN0YXR1cyAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXMnKSBhcyBIVE1MRGl2RWxlbWVudDtcblxuLy8g4pSA4pSAIFBhaXJpbmcgZm9ybSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgY29uc3QgY29kZSA9IGNvZGVJbnB1dC52YWx1ZS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgaWYgKCFpc1ZhbGlkUGFpckNvZGUoY29kZSkpIHtcbiAgICBzdGF0dXMudGV4dENvbnRlbnQgPSAnSW52YWxpZCBjb2RlLiBDb2RlcyBhcmUgNiBsZXR0ZXJzL2RpZ2l0cy4nO1xuICAgIHJldHVybjtcbiAgfVxuICBzdGF0dXMudGV4dENvbnRlbnQgPSAnQ29ubmVjdGluZ+KApic7XG4gIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgY21kOiAncGFpcicsIHBhaXJDb2RlOiBjb2RlIH0sIChyZXNwOiB7IG9rOiBib29sZWFuIH0pID0+IHtcbiAgICBzdGF0dXMudGV4dENvbnRlbnQgPSByZXNwPy5vayA/ICdQYWlyZWQuIFlvdSBjYW4gY2xvc2UgdGhpcyB3aW5kb3cuJyA6ICdQYWlyaW5nIGZhaWxlZC4nO1xuICB9KTtcbn0pO1xuXG4vLyDilIDilIAgR2F0ZSBsaXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gcmVuZGVyR2F0ZXMoZ2F0ZXM6IEhJVExHYXRlW10pOiB2b2lkIHtcbiAgZ2F0ZXNFbC5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgaWYgKGdhdGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgZW1wdHkuY2xhc3NOYW1lID0gJ2VtcHR5JztcbiAgICBlbXB0eS50ZXh0Q29udGVudCA9ICdObyBwZW5kaW5nIGdhdGVzLic7XG4gICAgZ2F0ZXNFbC5hcHBlbmRDaGlsZChlbXB0eSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3QgZ2F0ZSBvZiBnYXRlcykge1xuICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBjYXJkLmNsYXNzTmFtZSA9ICdnYXRlJztcbiAgICBjb25zdCBtc2cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBtc2cuY2xhc3NOYW1lID0gJ21zZyc7XG4gICAgbXNnLnRleHRDb250ZW50ID0gZ2F0ZS5tZXNzYWdlO1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHJvdy5jbGFzc05hbWUgPSAncm93JztcbiAgICBjb25zdCBkaXNtaXNzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgZGlzbWlzcy5jbGFzc05hbWUgPSAnZGlzbWlzcyc7XG4gICAgZGlzbWlzcy50ZXh0Q29udGVudCA9ICdEaXNtaXNzJztcbiAgICBkaXNtaXNzLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmVzcG9uZChnYXRlLmdhdGVJZCwgZmFsc2UpKTtcbiAgICBjb25zdCBhY2NlcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBhY2NlcHQuY2xhc3NOYW1lID0gJ2FjY2VwdCc7XG4gICAgYWNjZXB0LnRleHRDb250ZW50ID0gJ0FjY2VwdCc7XG4gICAgYWNjZXB0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmVzcG9uZChnYXRlLmdhdGVJZCwgdHJ1ZSkpO1xuICAgIHJvdy5hcHBlbmQoZGlzbWlzcywgYWNjZXB0KTtcbiAgICBjYXJkLmFwcGVuZChtc2csIHJvdyk7XG4gICAgZ2F0ZXNFbC5hcHBlbmRDaGlsZChjYXJkKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNwb25kKGdhdGVJZDogc3RyaW5nLCBhY2NlcHQ6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyBjbWQ6ICdoaXRsLXJlc29sdmUnLCBnYXRlSWQsIGFjY2VwdCB9KTtcbiAgLy8gT3B0aW1pc3RpYyDigJQgcmVtb3ZlIHRoZSBjYXJkIGltbWVkaWF0ZWx5OyB0aGUgbmV4dCBwb2xsIHdpbGwgcmVjdGlmeSBpZlxuICAvLyB0aGUgYmFja2dyb3VuZCBkaWQgbm90IGFjdHVhbGx5IHJlc29sdmUuXG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5nYXRlJykuZm9yRWFjaCgoZWwpID0+IHtcbiAgICBpZiAoZWwucXVlcnlTZWxlY3RvcignLm1zZycpKSAoZWwgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLm9wYWNpdHkgPSAnMC40JztcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvbGwoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgY21kOiAnaGl0bC1saXN0JyB9LCAocmVzcDogeyBvazogYm9vbGVhbjsgZ2F0ZXM/OiBISVRMR2F0ZVtdIH0pID0+IHtcbiAgICBpZiAocmVzcD8ub2spIHJlbmRlckdhdGVzKHJlc3AuZ2F0ZXMgPz8gW10pO1xuICB9KTtcbn1cblxudm9pZCBwb2xsKCk7XG5jb25zdCBpbnRlcnZhbElkID0gc2V0SW50ZXJ2YWwoKCkgPT4gdm9pZCBwb2xsKCksIDUwMCk7XG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigndW5sb2FkJywgKCkgPT4gY2xlYXJJbnRlcnZhbChpbnRlcnZhbElkKSk7XG4iXSwibmFtZXMiOltdLCJzb3VyY2VSb290IjoiIn0=