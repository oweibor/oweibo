import type { BrowserAction } from '@oweibo/core-contracts';
export interface ParsedSkillActions {
    actions: BrowserAction[];
    errors: string[];
}
export declare class BrowserSkillActionParser {
    parse(source: string): ParsedSkillActions;
}
//# sourceMappingURL=BrowserSkillActionParser.d.ts.map