"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxFactory = void 0;
const GVisorSandbox_js_1 = require("./GVisorSandbox.js");
const FirecrackerSandbox_js_1 = require("./FirecrackerSandbox.js");
class SandboxFactory {
    secrets;
    backend = null;
    constructor(secrets) {
        this.secrets = secrets;
    }
    async createSandbox() {
        if (!this.backend) {
            const creds = await this.secrets.getInfraCredentials('sandbox');
            this.backend = (creds['SANDBOX_BACKEND'] ?? 'gvisor');
        }
        if (this.backend === 'firecracker') {
            return new FirecrackerSandbox_js_1.FirecrackerSandbox();
        }
        return new GVisorSandbox_js_1.GVisorSandbox();
    }
    async drainPool() {
        console.log('[SandboxFactory] Pool drain requested. Next acquire() will cold-boot.');
    }
}
exports.SandboxFactory = SandboxFactory;
//# sourceMappingURL=SandboxFactory.js.map