// =====================================================================
// APP Notas — ponto de entrada do pacote do editor (Tiptap)
// O app não tem etapa de build: este arquivo é empacotado UMA vez pelo
// esbuild em js/vendor/tiptap.js, que vai para o repositório.
// Para atualizar o Tiptap: ver MANUTENCAO.md, "Atualizar o editor das notas".
// A configuração do editor (quais nós e marcas valem) fica no app, em js/nota.js.
// =====================================================================

export { Editor, Node, Mark, Extension, mergeAttributes, InputRule, PasteRule } from '@tiptap/core';
export { StarterKit } from '@tiptap/starter-kit';
export { Link } from '@tiptap/extension-link';
export { TaskList, TaskItem } from '@tiptap/extension-list';
export { Placeholder } from '@tiptap/extensions';
export { Markdown } from '@tiptap/markdown';
