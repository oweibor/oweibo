/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	// The require scope
/******/ 	var __webpack_require__ = {};
/******/ 	
/************************************************************************/
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
/*!*************************************!*\
  !*** ./src/content/hitl-overlay.ts ***!
  \*************************************/
__webpack_require__.r(__webpack_exports__);
// packages/browser-extension/src/content/hitl-overlay.ts
// Compiled to hitl-overlay.js. Runs in the page document context.
//
// Renders a floating top-right panel with Accept / Dismiss buttons for each
// pending HITL gate. Scoped under a single shadow host so page CSS cannot
// bleed into the overlay. Multiple concurrent gates stack vertically.
const HOST_ID = '__oweibo_hitl_host__';
function getRoot() {
    let host = document.getElementById(HOST_ID);
    if (host?.shadowRoot)
        return host.shadowRoot;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
    :host, .stack { font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    .stack { display: flex; flex-direction: column; gap: 10px; width: 320px; }
    .card {
      background: #1f2330; color: #f0f2f6; border: 1px solid #3a4256;
      border-radius: 10px; padding: 14px 16px; box-shadow: 0 8px 24px rgba(0,0,0,.3);
      animation: slide-in .18s ease-out;
    }
    .title { font-size: 12px; font-weight: 600; color: #9fb0d6; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 6px; }
    .msg   { font-size: 14px; line-height: 1.4; margin-bottom: 12px; }
    .row   { display: flex; gap: 8px; justify-content: flex-end; }
    button {
      font: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer; border: 0;
    }
    .accept  { background: #3b82f6; color: #fff; }
    .dismiss { background: #2d3444; color: #d9dfef; }
    .accept:hover  { background: #2f6ddb; }
    .dismiss:hover { background: #3a4256; }
    @keyframes slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }
    .leaving { animation: slide-out .18s ease-in forwards; }
    @keyframes slide-out { to { transform: translateX(20px); opacity: 0; } }
  `;
    const stack = document.createElement('div');
    stack.className = 'stack';
    root.append(style, stack);
    return root;
}
function stack(root) {
    return root.querySelector('.stack');
}
function showCard(gate) {
    const root = getRoot();
    if (root.querySelector(`[data-gate="${CSS.escape(gate.gateId)}"]`))
        return;
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-gate', gate.gateId);
    card.innerHTML = `
    <div class="title">Oweibo — approval required</div>
    <div class="msg"></div>
    <div class="row">
      <button class="dismiss">Dismiss</button>
      <button class="accept">Accept</button>
    </div>
  `;
    card.querySelector('.msg').textContent = gate.message;
    const respond = (accept) => {
        chrome.runtime.sendMessage({
            __oweiboHitlResolve: true,
            gateId: gate.gateId,
            accept,
            resolvedBy: 'overlay',
        });
    };
    card.querySelector('.accept').addEventListener('click', () => respond(true));
    card.querySelector('.dismiss').addEventListener('click', () => respond(false));
    stack(root).appendChild(card);
}
function dismissCard(gateId) {
    const root = getRoot();
    const card = root.querySelector(`[data-gate="${CSS.escape(gateId)}"]`);
    if (!card)
        return;
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 180);
}
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.__oweiboHitl === 'show')
        showCard(msg.gate);
    if (msg?.__oweiboHitl === 'dismiss')
        dismissCard(msg.gateId);
    return false;
});
window.__oweiboHitlOverlay = true;


/******/ })()
;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,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RUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3RHLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLE1BQWM7SUFDakMsTUFBTSxJQUFJLEdBQUcsT0FBTyxFQUFFLENBQUM7SUFDdkIsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxlQUFlLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3ZFLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTztJQUNsQixJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUM5QixVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ3ZDLENBQUM7QUFFRCxNQUFNLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFlLEVBQUUsRUFBRTtJQUN2RCxJQUFJLEdBQUcsRUFBRSxZQUFZLEtBQUssTUFBTTtRQUFLLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDeEQsSUFBSSxHQUFHLEVBQUUsWUFBWSxLQUFLLFNBQVM7UUFBRSxXQUFXLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzdELE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQyxDQUFDLENBQUM7QUFFRixNQUF1RCxDQUFDLG1CQUFtQixHQUFHLElBQUksQ0FBQyIsInNvdXJjZXMiOlsid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vd2VicGFjay9ib290c3RyYXAiLCJ3ZWJwYWNrOi8vQG93ZWliby9icm93c2VyLWV4dGVuc2lvbi93ZWJwYWNrL3J1bnRpbWUvbWFrZSBuYW1lc3BhY2Ugb2JqZWN0Iiwid2VicGFjazovL0Bvd2VpYm8vYnJvd3Nlci1leHRlbnNpb24vLi9zcmMvY29udGVudC9oaXRsLW92ZXJsYXkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gVGhlIHJlcXVpcmUgc2NvcGVcbnZhciBfX3dlYnBhY2tfcmVxdWlyZV9fID0ge307XG5cbiIsIi8vIGRlZmluZSBfX2VzTW9kdWxlIG9uIGV4cG9ydHNcbl9fd2VicGFja19yZXF1aXJlX18uciA9IChleHBvcnRzKSA9PiB7XG5cdGlmKHR5cGVvZiBTeW1ib2wgIT09ICd1bmRlZmluZWQnICYmIFN5bWJvbC50b1N0cmluZ1RhZykge1xuXHRcdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShleHBvcnRzLCBTeW1ib2wudG9TdHJpbmdUYWcsIHsgdmFsdWU6ICdNb2R1bGUnIH0pO1xuXHR9XG5cdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShleHBvcnRzLCAnX19lc01vZHVsZScsIHsgdmFsdWU6IHRydWUgfSk7XG59OyIsIi8vIHBhY2thZ2VzL2Jyb3dzZXItZXh0ZW5zaW9uL3NyYy9jb250ZW50L2hpdGwtb3ZlcmxheS50c1xuLy8gQ29tcGlsZWQgdG8gaGl0bC1vdmVybGF5LmpzLiBSdW5zIGluIHRoZSBwYWdlIGRvY3VtZW50IGNvbnRleHQuXG4vL1xuLy8gUmVuZGVycyBhIGZsb2F0aW5nIHRvcC1yaWdodCBwYW5lbCB3aXRoIEFjY2VwdCAvIERpc21pc3MgYnV0dG9ucyBmb3IgZWFjaFxuLy8gcGVuZGluZyBISVRMIGdhdGUuIFNjb3BlZCB1bmRlciBhIHNpbmdsZSBzaGFkb3cgaG9zdCBzbyBwYWdlIENTUyBjYW5ub3Rcbi8vIGJsZWVkIGludG8gdGhlIG92ZXJsYXkuIE11bHRpcGxlIGNvbmN1cnJlbnQgZ2F0ZXMgc3RhY2sgdmVydGljYWxseS5cblxuaW1wb3J0IHR5cGUgeyBISVRMR2F0ZSB9IGZyb20gJy4uL3NoYXJlZC9hY3Rpb25zLmpzJztcblxuaW50ZXJmYWNlIFNob3dNc2cgICAgeyBfX293ZWlib0hpdGw6ICdzaG93JzsgICAgZ2F0ZTogSElUTEdhdGUgfVxuaW50ZXJmYWNlIERpc21pc3NNc2cgeyBfX293ZWlib0hpdGw6ICdkaXNtaXNzJzsgZ2F0ZUlkOiBzdHJpbmcgfVxudHlwZSBPdmVybGF5TXNnID0gU2hvd01zZyB8IERpc21pc3NNc2c7XG5cbmNvbnN0IEhPU1RfSUQgPSAnX19vd2VpYm9faGl0bF9ob3N0X18nO1xuXG5mdW5jdGlvbiBnZXRSb290KCk6IFNoYWRvd1Jvb3Qge1xuICBsZXQgaG9zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEhPU1RfSUQpO1xuICBpZiAoaG9zdD8uc2hhZG93Um9vdCkgcmV0dXJuIGhvc3Quc2hhZG93Um9vdDtcblxuICBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gIGhvc3QuaWQgPSBIT1NUX0lEO1xuICBob3N0LnN0eWxlLmNzc1RleHQgPSAnYWxsOiBpbml0aWFsOyBwb3NpdGlvbjogZml4ZWQ7IHRvcDogMTZweDsgcmlnaHQ6IDE2cHg7IHotaW5kZXg6IDIxNDc0ODM2NDc7JztcbiAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKGhvc3QpO1xuXG4gIGNvbnN0IHJvb3QgPSBob3N0LmF0dGFjaFNoYWRvdyh7IG1vZGU6ICdvcGVuJyB9KTtcbiAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpO1xuICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiAgICA6aG9zdCwgLnN0YWNrIHsgZm9udC1mYW1pbHk6IC1hcHBsZS1zeXN0ZW0sIHN5c3RlbS11aSwgU2Vnb2UgVUksIHNhbnMtc2VyaWY7IH1cbiAgICAuc3RhY2sgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDEwcHg7IHdpZHRoOiAzMjBweDsgfVxuICAgIC5jYXJkIHtcbiAgICAgIGJhY2tncm91bmQ6ICMxZjIzMzA7IGNvbG9yOiAjZjBmMmY2OyBib3JkZXI6IDFweCBzb2xpZCAjM2E0MjU2O1xuICAgICAgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTRweCAxNnB4OyBib3gtc2hhZG93OiAwIDhweCAyNHB4IHJnYmEoMCwwLDAsLjMpO1xuICAgICAgYW5pbWF0aW9uOiBzbGlkZS1pbiAuMThzIGVhc2Utb3V0O1xuICAgIH1cbiAgICAudGl0bGUgeyBmb250LXNpemU6IDEycHg7IGZvbnQtd2VpZ2h0OiA2MDA7IGNvbG9yOiAjOWZiMGQ2OyBsZXR0ZXItc3BhY2luZzogLjA0ZW07IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IG1hcmdpbi1ib3R0b206IDZweDsgfVxuICAgIC5tc2cgICB7IGZvbnQtc2l6ZTogMTRweDsgbGluZS1oZWlnaHQ6IDEuNDsgbWFyZ2luLWJvdHRvbTogMTJweDsgfVxuICAgIC5yb3cgICB7IGRpc3BsYXk6IGZsZXg7IGdhcDogOHB4OyBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtZW5kOyB9XG4gICAgYnV0dG9uIHtcbiAgICAgIGZvbnQ6IGluaGVyaXQ7IHBhZGRpbmc6IDZweCAxMnB4OyBib3JkZXItcmFkaXVzOiA2cHg7IGN1cnNvcjogcG9pbnRlcjsgYm9yZGVyOiAwO1xuICAgIH1cbiAgICAuYWNjZXB0ICB7IGJhY2tncm91bmQ6ICMzYjgyZjY7IGNvbG9yOiAjZmZmOyB9XG4gICAgLmRpc21pc3MgeyBiYWNrZ3JvdW5kOiAjMmQzNDQ0OyBjb2xvcjogI2Q5ZGZlZjsgfVxuICAgIC5hY2NlcHQ6aG92ZXIgIHsgYmFja2dyb3VuZDogIzJmNmRkYjsgfVxuICAgIC5kaXNtaXNzOmhvdmVyIHsgYmFja2dyb3VuZDogIzNhNDI1NjsgfVxuICAgIEBrZXlmcmFtZXMgc2xpZGUtaW4geyBmcm9tIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGVYKDIwcHgpOyBvcGFjaXR5OiAwOyB9IHRvIHsgdHJhbnNmb3JtOiBub25lOyBvcGFjaXR5OiAxOyB9IH1cbiAgICAubGVhdmluZyB7IGFuaW1hdGlvbjogc2xpZGUtb3V0IC4xOHMgZWFzZS1pbiBmb3J3YXJkczsgfVxuICAgIEBrZXlmcmFtZXMgc2xpZGUtb3V0IHsgdG8geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMjBweCk7IG9wYWNpdHk6IDA7IH0gfVxuICBgO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICBzdGFjay5jbGFzc05hbWUgPSAnc3RhY2snO1xuICByb290LmFwcGVuZChzdHlsZSwgc3RhY2spO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gc3RhY2socm9vdDogU2hhZG93Um9vdCk6IEhUTUxFbGVtZW50IHtcbiAgcmV0dXJuIHJvb3QucXVlcnlTZWxlY3RvcignLnN0YWNrJykgYXMgSFRNTEVsZW1lbnQ7XG59XG5cbmZ1bmN0aW9uIHNob3dDYXJkKGdhdGU6IEhJVExHYXRlKTogdm9pZCB7XG4gIGNvbnN0IHJvb3QgPSBnZXRSb290KCk7XG4gIGlmIChyb290LnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWdhdGU9XCIke0NTUy5lc2NhcGUoZ2F0ZS5nYXRlSWQpfVwiXWApKSByZXR1cm47XG5cbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICBjYXJkLmNsYXNzTmFtZSA9ICdjYXJkJztcbiAgY2FyZC5zZXRBdHRyaWJ1dGUoJ2RhdGEtZ2F0ZScsIGdhdGUuZ2F0ZUlkKTtcbiAgY2FyZC5pbm5lckhUTUwgPSBgXG4gICAgPGRpdiBjbGFzcz1cInRpdGxlXCI+T3dlaWJvIOKAlCBhcHByb3ZhbCByZXF1aXJlZDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJtc2dcIj48L2Rpdj5cbiAgICA8ZGl2IGNsYXNzPVwicm93XCI+XG4gICAgICA8YnV0dG9uIGNsYXNzPVwiZGlzbWlzc1wiPkRpc21pc3M8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJhY2NlcHRcIj5BY2NlcHQ8L2J1dHRvbj5cbiAgICA8L2Rpdj5cbiAgYDtcbiAgKGNhcmQucXVlcnlTZWxlY3RvcignLm1zZycpIGFzIEhUTUxFbGVtZW50KS50ZXh0Q29udGVudCA9IGdhdGUubWVzc2FnZTtcblxuICBjb25zdCByZXNwb25kID0gKGFjY2VwdDogYm9vbGVhbik6IHZvaWQgPT4ge1xuICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHtcbiAgICAgIF9fb3dlaWJvSGl0bFJlc29sdmU6IHRydWUsXG4gICAgICBnYXRlSWQ6IGdhdGUuZ2F0ZUlkLFxuICAgICAgYWNjZXB0LFxuICAgICAgcmVzb2x2ZWRCeTogJ292ZXJsYXknLFxuICAgIH0pO1xuICB9O1xuICAoY2FyZC5xdWVyeVNlbGVjdG9yKCcuYWNjZXB0JykgIGFzIEhUTUxCdXR0b25FbGVtZW50KS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlc3BvbmQodHJ1ZSkpO1xuICAoY2FyZC5xdWVyeVNlbGVjdG9yKCcuZGlzbWlzcycpIGFzIEhUTUxCdXR0b25FbGVtZW50KS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlc3BvbmQoZmFsc2UpKTtcbiAgc3RhY2socm9vdCkuYXBwZW5kQ2hpbGQoY2FyZCk7XG59XG5cbmZ1bmN0aW9uIGRpc21pc3NDYXJkKGdhdGVJZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHJvb3QgPSBnZXRSb290KCk7XG4gIGNvbnN0IGNhcmQgPSByb290LnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWdhdGU9XCIke0NTUy5lc2NhcGUoZ2F0ZUlkKX1cIl1gKTtcbiAgaWYgKCFjYXJkKSByZXR1cm47XG4gIGNhcmQuY2xhc3NMaXN0LmFkZCgnbGVhdmluZycpO1xuICBzZXRUaW1lb3V0KCgpID0+IGNhcmQucmVtb3ZlKCksIDE4MCk7XG59XG5cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobXNnOiBPdmVybGF5TXNnKSA9PiB7XG4gIGlmIChtc2c/Ll9fb3dlaWJvSGl0bCA9PT0gJ3Nob3cnKSAgICBzaG93Q2FyZChtc2cuZ2F0ZSk7XG4gIGlmIChtc2c/Ll9fb3dlaWJvSGl0bCA9PT0gJ2Rpc21pc3MnKSBkaXNtaXNzQ2FyZChtc2cuZ2F0ZUlkKTtcbiAgcmV0dXJuIGZhbHNlO1xufSk7XG5cbih3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fb3dlaWJvSGl0bE92ZXJsYXk/OiBib29sZWFuIH0pLl9fb3dlaWJvSGl0bE92ZXJsYXkgPSB0cnVlO1xuIl0sIm5hbWVzIjpbXSwic291cmNlUm9vdCI6IiJ9