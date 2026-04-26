/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/*!*********************!*\
  !*** ./src/pair.ts ***!
  \*********************/

// packages/browser-extension/src/pair.ts
// Compiled to pair.js. Deep-link pairing handler.
//
// Flow:
//   1. CLI opens chrome-extension://<id>/pair.html?token=<pairingToken>
//   2. User clicks Connect.
//   3. Page posts { cmd: 'pair', pairToken } to background service worker.
//   4. Background opens the native messaging port, exchanges HMAC, then
//      responds { ok: true } or { ok: false, reason }.
const params = new URLSearchParams(location.search);
const pairToken = params.get('token') ?? '';
const connectBtn = document.getElementById('connect');
const cancelBtn = document.getElementById('cancel');
const statusEl = document.getElementById('status');
function setStatus(kind, msg) {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = msg;
}
if (!pairToken) {
    setStatus('err', 'Missing pairing token. Re-run the oweibo CLI.');
    connectBtn.disabled = true;
}
connectBtn.addEventListener('click', () => {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    chrome.runtime.sendMessage({ cmd: 'pair-deeplink', pairToken }, (res) => {
        if (res?.ok) {
            setStatus('ok', 'Connected. You can close this tab.');
            connectBtn.textContent = 'Connected';
        }
        else {
            setStatus('err', `Pairing failed: ${res?.reason ?? 'unknown error'}`);
            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect';
        }
    });
});
cancelBtn.addEventListener('click', () => window.close());

/******/ })()
;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFpci5qcyIsIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSx5Q0FBeUM7QUFDekMsa0RBQWtEO0FBQ2xELEVBQUU7QUFDRixRQUFRO0FBQ1Isd0VBQXdFO0FBQ3hFLDRCQUE0QjtBQUM1QiwyRUFBMkU7QUFDM0Usd0VBQXdFO0FBQ3hFLHVEQUF1RDtBQUV2RCxNQUFNLE1BQU0sR0FBRyxJQUFJLGVBQWUsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDcEQsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUM7QUFFNUMsTUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQWMsQ0FBQyxTQUFTLENBQXNCLENBQUM7QUFDM0UsTUFBTSxTQUFTLEdBQUksUUFBUSxDQUFDLGNBQWMsQ0FBQyxRQUFRLENBQXVCLENBQUM7QUFDM0UsTUFBTSxRQUFRLEdBQUssUUFBUSxDQUFDLGNBQWMsQ0FBQyxRQUFRLENBQW9CLENBQUM7QUFFeEUsU0FBUyxTQUFTLENBQUMsSUFBa0IsRUFBRSxHQUFXO0lBQ2hELFFBQVEsQ0FBQyxTQUFTLEdBQUcsVUFBVSxJQUFJLEVBQUUsQ0FBQztJQUN0QyxRQUFRLENBQUMsV0FBVyxHQUFHLEdBQUcsQ0FBQztBQUM3QixDQUFDO0FBRUQsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO0lBQ2YsU0FBUyxDQUFDLEtBQUssRUFBRSwrQ0FBK0MsQ0FBQyxDQUFDO0lBQ2xFLFVBQVUsQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDO0FBQzdCLENBQUM7QUFFRCxVQUFVLENBQUMsZ0JBQWdCLENBQUMsT0FBTyxFQUFFLEdBQUcsRUFBRTtJQUN4QyxVQUFVLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQztJQUMzQixVQUFVLENBQUMsV0FBVyxHQUFHLGFBQWEsQ0FBQztJQUN2QyxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FDeEIsRUFBRSxHQUFHLEVBQUUsZUFBZSxFQUFFLFNBQVMsRUFBRSxFQUNuQyxDQUFDLEdBQWlELEVBQUUsRUFBRTtRQUNwRCxJQUFJLEdBQUcsRUFBRSxFQUFFLEVBQUUsQ0FBQztZQUNaLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0NBQW9DLENBQUMsQ0FBQztZQUN0RCxVQUFVLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQztRQUN2QyxDQUFDO2FBQU0sQ0FBQztZQUNOLFNBQVMsQ0FBQyxLQUFLLEVBQUUsbUJBQW1CLEdBQUcsRUFBRSxNQUFNLElBQUksZUFBZSxFQUFFLENBQUMsQ0FBQztZQUN0RSxVQUFVLENBQUMsUUFBUSxHQUFHLEtBQUssQ0FBQztZQUM1QixVQUFVLENBQUMsV0FBVyxHQUFHLFNBQVMsQ0FBQztRQUNyQyxDQUFDO0lBQ0gsQ0FBQyxDQUNGLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQztBQUVILFNBQVMsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUMiLCJzb3VyY2VzIjpbIndlYnBhY2s6Ly9Ab3dlaWJvL2Jyb3dzZXItZXh0ZW5zaW9uLy4vc3JjL3BhaXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vc3JjL3BhaXIudHNcbi8vIENvbXBpbGVkIHRvIHBhaXIuanMuIERlZXAtbGluayBwYWlyaW5nIGhhbmRsZXIuXG4vL1xuLy8gRmxvdzpcbi8vICAgMS4gQ0xJIG9wZW5zIGNocm9tZS1leHRlbnNpb246Ly88aWQ+L3BhaXIuaHRtbD90b2tlbj08cGFpcmluZ1Rva2VuPlxuLy8gICAyLiBVc2VyIGNsaWNrcyBDb25uZWN0LlxuLy8gICAzLiBQYWdlIHBvc3RzIHsgY21kOiAncGFpcicsIHBhaXJUb2tlbiB9IHRvIGJhY2tncm91bmQgc2VydmljZSB3b3JrZXIuXG4vLyAgIDQuIEJhY2tncm91bmQgb3BlbnMgdGhlIG5hdGl2ZSBtZXNzYWdpbmcgcG9ydCwgZXhjaGFuZ2VzIEhNQUMsIHRoZW5cbi8vICAgICAgcmVzcG9uZHMgeyBvazogdHJ1ZSB9IG9yIHsgb2s6IGZhbHNlLCByZWFzb24gfS5cblxuY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhsb2NhdGlvbi5zZWFyY2gpO1xuY29uc3QgcGFpclRva2VuID0gcGFyYW1zLmdldCgndG9rZW4nKSA/PyAnJztcblxuY29uc3QgY29ubmVjdEJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb25uZWN0JykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG5jb25zdCBjYW5jZWxCdG4gID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhbmNlbCcpICBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbmNvbnN0IHN0YXR1c0VsICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzJykgIGFzIEhUTUxEaXZFbGVtZW50O1xuXG5mdW5jdGlvbiBzZXRTdGF0dXMoa2luZDogJ29rJyB8ICdlcnInLCBtc2c6IHN0cmluZyk6IHZvaWQge1xuICBzdGF0dXNFbC5jbGFzc05hbWUgPSBgc3RhdHVzICR7a2luZH1gO1xuICBzdGF0dXNFbC50ZXh0Q29udGVudCA9IG1zZztcbn1cblxuaWYgKCFwYWlyVG9rZW4pIHtcbiAgc2V0U3RhdHVzKCdlcnInLCAnTWlzc2luZyBwYWlyaW5nIHRva2VuLiBSZS1ydW4gdGhlIG93ZWlibyBDTEkuJyk7XG4gIGNvbm5lY3RCdG4uZGlzYWJsZWQgPSB0cnVlO1xufVxuXG5jb25uZWN0QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICBjb25uZWN0QnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgY29ubmVjdEJ0bi50ZXh0Q29udGVudCA9ICdDb25uZWN0aW5n4oCmJztcbiAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoXG4gICAgeyBjbWQ6ICdwYWlyLWRlZXBsaW5rJywgcGFpclRva2VuIH0sXG4gICAgKHJlczogeyBvazogYm9vbGVhbjsgcmVhc29uPzogc3RyaW5nIH0gfCB1bmRlZmluZWQpID0+IHtcbiAgICAgIGlmIChyZXM/Lm9rKSB7XG4gICAgICAgIHNldFN0YXR1cygnb2snLCAnQ29ubmVjdGVkLiBZb3UgY2FuIGNsb3NlIHRoaXMgdGFiLicpO1xuICAgICAgICBjb25uZWN0QnRuLnRleHRDb250ZW50ID0gJ0Nvbm5lY3RlZCc7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZXRTdGF0dXMoJ2VycicsIGBQYWlyaW5nIGZhaWxlZDogJHtyZXM/LnJlYXNvbiA/PyAndW5rbm93biBlcnJvcid9YCk7XG4gICAgICAgIGNvbm5lY3RCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgY29ubmVjdEJ0bi50ZXh0Q29udGVudCA9ICdDb25uZWN0JztcbiAgICAgIH1cbiAgICB9LFxuICApO1xufSk7XG5cbmNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHdpbmRvdy5jbG9zZSgpKTtcbiJdLCJuYW1lcyI6W10sInNvdXJjZVJvb3QiOiIifQ==