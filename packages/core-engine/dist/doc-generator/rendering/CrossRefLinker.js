"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrossRefLinker = void 0;
/**
 * CrossRefLinker — post-processes rendered Markdown to inject cross-references.
 *
 * Resolves `[[SymbolName]]` wiki-style links to the correct document anchor,
 * using moduleHash for disambiguation when the same symbol name appears in
 * multiple modules.
 */
class CrossRefLinker {
    link(documents, knowledge) {
        // Build symbol → anchor map. When a symbol appears in multiple files,
        // the moduleHash suffix disambiguates (e.g. [[EventDoc#a1b2c3]]).
        const symbolIndex = new Map();
        for (const sym of knowledge.symbols) {
            const docFile = this.findDocForSymbol(sym.filePath, documents, knowledge);
            if (!docFile)
                continue;
            const anchor = `${docFile}#${sym.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
            const key = sym.moduleHash ? `${sym.name}#${sym.moduleHash}` : sym.name;
            symbolIndex.set(sym.name, anchor); // last-write wins for unqualified
            symbolIndex.set(key, anchor); // qualified always wins
        }
        return documents.map((doc) => ({
            ...doc,
            rendered: this.resolveLinks(doc.rendered, symbolIndex),
            sections: doc.sections.map((s) => ({
                ...s,
                content: this.resolveLinks(s.content, symbolIndex),
            })),
        }));
    }
    resolveLinks(text, index) {
        return text.replace(/\[\[([^\]]+)\]\]/g, (_match, ref) => {
            const target = index.get(ref.trim());
            if (!target)
                return `\`${ref.trim()}\``;
            return `[\`${ref.trim()}\`](${target})`;
        });
    }
    findDocForSymbol(filePath, documents, knowledge) {
        const mod = knowledge.modules.find((m) => filePath.startsWith(m.rootPath));
        if (!mod)
            return undefined;
        const modDoc = documents.find((d) => d.category === 'module-reference');
        if (modDoc)
            return modDoc.fileName;
        return documents.find((d) => d.category === 'api-reference')?.fileName;
    }
}
exports.CrossRefLinker = CrossRefLinker;
//# sourceMappingURL=CrossRefLinker.js.map