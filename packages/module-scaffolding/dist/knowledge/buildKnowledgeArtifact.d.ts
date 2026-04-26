import type { ArtifactFile, ModuleKnowledge, UserFlowDoc, GlossaryEntry, ExampleUsageDoc, ScaffoldInput } from '@oweibo/core-contracts';
export interface KnowledgeArtifactInputs {
    moduleName: string;
    scaffoldInput: ScaffoldInput;
    bundle: {
        files: ArtifactFile[];
        testFiles: ArtifactFile[];
    };
    architectKnowledge: {
        userFlows: UserFlowDoc[];
        glossary: GlossaryEntry[];
        domainDescription: string;
    };
    executorExampleUsages: ExampleUsageDoc[];
}
export declare function buildKnowledgeArtifact(inputs: KnowledgeArtifactInputs): ModuleKnowledge;
//# sourceMappingURL=buildKnowledgeArtifact.d.ts.map