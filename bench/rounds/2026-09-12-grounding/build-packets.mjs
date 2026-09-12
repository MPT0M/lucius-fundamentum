/**
 * Um arquivo por pergunta: o enunciado e exatamente os 10 trechos que a
 * busca devolve, com o identificador de cada um. Nada mais.
 *
 * Um arquivo por pergunta, e nao um arquivo so, porque o agente le em ordem
 * e o contexto dele cresce a cada leitura — que e' a forma de uma conversa.
 * Num arquivo unico ele veria a pergunta 40 enquanto responde a 3, e o
 * mimetismo que queremos observar deixaria de ser observavel.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Paths resolve from this file, so the script runs wherever the repository is
 * cloned. The round's own artefacts sit beside it; the corpus and the built
 * library are found by walking up to the repository root.
 *
 * Requires `npm run build` at the root: the index is imported from `dist/`.
 */
const AQUI = new URL('./', import.meta.url);
const RAIZ = new URL('../../../', AQUI);
const CORPUS = fileURLToPath(new URL('bench/corpus/public/', RAIZ));

const OUT = fileURLToPath(new URL('packets/', AQUI));
const { createIndex } = await import(new URL('dist/index-build.js', RAIZ).href);

const docs = readdirSync(CORPUS)
    .filter((n) => n.endsWith('.txt'))
    .sort()
    .map((n) => ({ id: n.replace(/\.txt$/, ''), title: n, text: readFileSync(CORPUS + n, 'utf8') }));

const linhas = readFileSync(fileURLToPath(new URL('questions.md', AQUI)), 'utf8').split(/\r?\n/);
const perguntas = [];
for (const ln of linhas) {
    const m = /^\s*(\d+)[.)]\s*(.+)$/.exec(ln);
    if (m) perguntas.push({ n: Number(m[1]), texto: m[2].trim() });
}

const index = createIndex(docs);
mkdirSync(OUT, { recursive: true });

let semNada = 0;
for (const { n, texto } of perguntas) {
    const r = index.searchLexical(texto, { topK: 10 });
    if (r.length === 0) semNada += 1;
    const partes = [`PERGUNTA: ${texto}`, ``, `TRECHOS RECUPERADOS (${r.length}):`, ``];
    for (const h of r) partes.push(`### [${h.chunk.id}]`, h.chunk.text.trim(), ``);
    writeFileSync(`${OUT}packet-${String(n).padStart(2, '0')}.md`, partes.join('\n'), 'utf8');
}

const bytes = readdirSync(OUT).reduce((s, f) => s + readFileSync(OUT + f).length, 0);
console.log(`pacotes escritos: ${perguntas.length}`);
console.log(`perguntas cuja busca nao devolveu nada: ${semNada}`);
console.log(`tamanho total: ${(bytes / 1024).toFixed(0)} KB, media ${(bytes / perguntas.length / 1024).toFixed(1)} KB por pacote`);
