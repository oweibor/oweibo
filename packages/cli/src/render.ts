/**
 * render.ts — doc-generator icon mappings for the CLI renderer (§4.3.3, v10.5).
 *
 * Used by `oweibo docs` to render SSE event stream with category-specific icons.
 * Emojis are CLI-only — they are never written into generated documentation files.
 */

export const DOC_CATEGORY_ICONS: Record<string, string> = {
  'architecture':    '\u{1F3DB}\u{FE0F}',   // 🏛️
  'api-reference':   '\u{1F4D6}',            // 📖
  'developer-guide': '\u{1F6E0}\u{FE0F}',   // 🛠️
  'module-reference':'\u{1F4E6}',            // 📦
  'data-model':      '\u{1F5C3}\u{FE0F}',   // 🗃️
  'event-catalogue': '\u{1F4E1}',            // 📡
  'adr':             '\u{1F4CB}',            // 📋
  'dependency-map':  '\u{1F517}',            // 🔗
  'getting-started': '\u{1F680}',            // 🚀
  'glossary':        '\u{1F4DA}',            // 📚
  'changelog':       '\u{1F4C5}',            // 📅
};

export const DOC_EVENT_ICONS: Record<string, string> = {
  'codebase-analysis-started':  '\u{1F50D}',  // 🔍
  'codebase-analysis-progress': '\u{23F3}',   // ⏳
  'codebase-analysis-complete': '\u{2705}',   // ✅
  'doc-generation-started':     '\u{1F4DD}',  // 📝
  'doc-template-rendered':      '\u{1F4C4}',  // 📄
  'doc-generation-complete':    '\u{1F389}',  // 🎉
  'doc-generation-warning':     '\u{26A0}\u{FE0F}', // ⚠️
};
