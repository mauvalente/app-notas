# ci/tiptap — pacote do editor das notas

Gera o `js/vendor/tiptap.js`, o editor usado nos assuntos do tipo Nota (SPEC 12.5).
O app continua sem etapa de build: o arquivo gerado vai para o repositório, como o `js/vendor/supabase.js`.

Só precisa rodar quando for **atualizar o Tiptap** (precisa do Node.js 18 ou mais novo):

```bash
cd ci/tiptap
npm ci            # instala exatamente as versões do package-lock.json
npm run build     # gera ../../js/vendor/tiptap.js
```

Para subir de versão: troque os números no `package.json` (todos os `@tiptap/*` com a mesma versão), rode `npm install` e `npm run build`, teste uma nota no celular e no computador e aumente o `CACHE` no `sw.js`.
