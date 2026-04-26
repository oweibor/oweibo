import type { IPromptBudgetCollaborator, ITokenizer } from '@oweibo/core-contracts';
export declare class BrowserPromptBudget implements IPromptBudgetCollaborator {
    readonly sectionKey = "browser-observations";
    trim(sectionText: string, tokenBudget: number, tokenizer: ITokenizer): Promise<{
        trimmed: string;
        tokensUsed: number;
    }>;
}
//# sourceMappingURL=BrowserPromptBudget.d.ts.map