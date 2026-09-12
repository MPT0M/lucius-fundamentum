/**
 * Cruza o veredito do juiz com a resposta de cada corrida. Nenhuma decisao
 * minha entra aqui: o juiz citou o TEXTO LITERAL, entao eu localizo em qual
 * pedaco aquele texto mora e comparo com o pedaco que o modelo citou.
 *
 * Duas correcoes que a primeira versao errava, as duas medidas:
 *
 *  - o juiz ELIDE trechos longos com `(...)`, que e' como se cita norma. A
 *    citacao se parte nos pontos de elisao e cada fragmento e' procurado em
 *    separado; os pedacos que sustentam a citacao sao a uniao dos que contem
 *    algum fragmento. Exigir a string inteira contigua reprovava 5 de 52.
 *  - uma citacao pode ATRAVESSAR a fronteira de dois pedacos. Nesse caso ela
 *    nao esta inteira em nenhum, e a busca cai para o documento: o pedaco que
 *    cobre a posicao encontrada e' o que sustenta. Eram 2 de 52.
 *
 * E uma categoria que a primeira versao nao tinha e que inverte a leitura:
 * na versao B o modelo escreveu `Fonte: nenhuma`. Isso NAO e' confabular —
 * e' responder recusando-se a fundamentar. Contar junto com "inventou" diz o
 * oposto do que aconteceu.
 *
 * Uso: node contar.mjs <arquivo-de-respostas> [...]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
const R = fileURLToPath(new URL('runs/', AQUI));
const J = fileURLToPath(new URL('judgements/', AQUI));
const { createIndex } = await import(new URL('dist/index-build.js', RAIZ).href);

const docs = readdirSync(CORPUS)
    .filter((n) => n.endsWith('.txt'))
    .sort()
    .map((n) => ({ id: n.replace(/\.txt$/, ''), title: n, text: readFileSync(CORPUS + n, 'utf8') }));
const artifact = createIndex(docs).serialize();

const achatar = (s) => s.replace(/\s+/gu, ' ').trim().toLowerCase();
const chunks = artifact.chunks.map((c) => ({ id: c.id, doc: c.documentId, texto: achatar(c.text) }));
const documentos = new Map(docs.map((d) => [d.id, achatar(d.text)]));
const idsValidos = new Set(artifact.chunks.map((c) => c.id));

const ELISAO = /\(\s*\.\.\.\s*\)|\[\s*\.\.\.\s*\]/gu;
const MINIMO = 25;

/**
 * O maior prefixo de `texto` que aparece em algum pedaco, ou 0.
 * Busca binaria: o conjunto dos prefixos que casam e' um prefixo fechado.
 */
function maiorPrefixoQueCasa(texto) {
    let lo = 0, hi = texto.length;
    while (lo < hi) {
        const meio = Math.ceil((lo + hi) / 2);
        if (chunks.some((c) => c.texto.includes(texto.slice(0, meio)))) lo = meio;
        else hi = meio - 1;
    }
    return lo;
}

/**
 * Pedacos que sustentam uma citacao do juiz.
 *
 * Exigir que a citacao apareca CONTIGUA num pedaco reprovava tres perguntas
 * em sessenta, e reprovava respostas certas: com o conjunto vazio, qualquer
 * coisa que o modelo citasse virava "vizinha". Duas causas, medidas:
 *
 *  - o juiz costura itens NAO contiguos de uma lista numa citacao so, as
 *    vezes marcando a elisao com `(...)` e as vezes nao (#8, #53);
 *  - a citacao atravessa a fronteira de dois pedacos, e entao nao esta
 *    inteira em nenhum (#32).
 *
 * A saida e' nao exigir contiguidade: consome a citacao em fragmentos
 * MAXIMOS, cada um o maior pedaco de texto que ainda casa, e a uniao dos
 * pedacos que contem algum fragmento e' o conjunto que sustenta. Cobre a
 * elisao marcada, a nao marcada e a fronteira com um mecanismo so.
 *
 * E' a mesma familia do `notLocated` da regua: casamento por substring
 * exata contra texto que quem cita pode ter alterado.
 */
function pedacosDaCitacao(citacao) {
    const achados = new Set();
    let fragmentos = 0;

    for (const parte of achatar(citacao).split(ELISAO)) {
        let resto = parte.trim();
        while (resto.length >= MINIMO) {
            const n = maiorPrefixoQueCasa(resto);
            if (n < MINIMO) { resto = resto.slice(1).trimStart(); continue; }
            const frag = resto.slice(0, n);
            fragmentos += 1;
            for (const c of chunks) if (c.texto.includes(frag)) achados.add(c.id);
            resto = resto.slice(n).trimStart();
        }
    }

    return { pedacos: achados, fragmentos, semLocal: achados.size === 0 };
}

function lerJuiz(arquivo) {
    const blocos = readFileSync(arquivo, 'utf8').split(/^##\s+/m).slice(1);
    const out = new Map();
    let citacoes = 0, naoLocalizadas = 0;
    for (const b of blocos) {
        const n = Number(/^(\d+)/.exec(b)?.[1]);
        if (!Number.isInteger(n)) continue;
        const bruta = /Situa[çc][ãa]o:\s*(RESPONDE|PARCIAL|N[ÃA]O CONSTA)/iu.exec(b)?.[1]?.toUpperCase() ?? '?';
        const situacao = bruta.replace('NAO', 'NÃO');
        const pedacos = new Set();
        for (const m of b.matchAll(/[—-]\s*"([^"]+)"/gu)) {
            citacoes += 1;
            const r = pedacosDaCitacao(m[1]);
            if (r.pedacos.size === 0) naoLocalizadas += 1;
            for (const p of r.pedacos) pedacos.add(p);
        }
        out.set(n, { situacao, pedacos });
    }
    return { juiz: out, citacoes, naoLocalizadas };
}

const SEM_FONTE = /^(nenhuma|nenhum|—|-|n\/a|)$/iu;

function lerRespostas(arquivo) {
    const blocos = readFileSync(arquivo, 'utf8').split(/^##\s+/m).slice(1);
    const out = new Map();
    for (const b of blocos) {
        const n = Number(/^(\d+)/.exec(b)?.[1]);
        if (!Number.isInteger(n)) continue;
        const resposta = /Resposta:\s*([\s\S]*?)(?=\nFonte:|$)/iu.exec(b)?.[1]?.trim() ?? '';
        const fonte = /Fonte:\s*(.+)/iu.exec(b)?.[1]?.trim() ?? '';
        const ids = [...fonte.matchAll(/\[?([a-z0-9-]+#\d+)\]?/giu)].map((m) => m[1]);
        out.set(n, {
            recusou: /N[ÃA]O CONSTA/iu.test(resposta),
            semFonte: ids.length === 0 && SEM_FONTE.test(fonte),
            ids,
        });
    }
    return out;
}

/**
 * Duas correcoes ao veredito do juiz, cada uma com o texto que a sustenta.
 * Ficam aqui, e nao dentro de `juiz-claude.md`, porque o arquivo do juiz e'
 * evidencia do que ele julgou — reescrever apaga o erro em vez de registra-lo.
 *
 *  #21  o juiz disse NÃO CONSTA. O art. 14 da Resolucao CNE/CEB 2 responde
 *       em texto literal, e a busca o trouxe em #2. O juiz Gemini achou; o
 *       meu nao, porque a pergunta diz "bloqueador" e a norma "bloqueio de
 *       sinal", e ele nao insistiu. Foi a unica divergencia entre os dois
 *       juizes, e conferi no corpus.
 *
 *  #44  os dois juizes disseram NÃO CONSTA e os dois cacadores acharam o
 *       mesmo artigo. Eu li como resposta vizinha e errei: a pergunta faz um
 *       recorte de renda e o dispositivo diz "ao educando", "em todas as
 *       etapas", sem condicionar. Num dever universal a ausencia de
 *       restricao e' a resposta, nao a lacuna. O dono desempatou.
 */
const CORRECOES = [
    { n: 21, situacao: 'RESPONDE', citacao: 'Soluções tecnológicas para implementar bloqueio de sinal não são recomendadas' },
    { n: 44, situacao: 'RESPONDE', citacao: 'atendimento ao educando, em todas as etapas da educação básica, por meio de programas suplementares de material didático-escolar, transporte, alimentação e assistência à saúde' },
];

const { juiz, citacoes, naoLocalizadas } = lerJuiz(J + 'juiz-claude.md');

for (const { n, situacao, citacao } of CORRECOES) {
    const { pedacos } = pedacosDaCitacao(citacao);
    if (pedacos.size === 0) throw new Error(`correcao da #${n}: a citacao nao foi localizada no corpus`);
    juiz.set(n, { situacao, pedacos });
    console.log(`correcao aplicada #${n} -> ${situacao} (${[...pedacos].join(', ')})`);
}
console.log();
const conta = (s) => [...juiz.values()].filter((v) => v.situacao === s).length;
console.log(`juiz: ${juiz.size} perguntas | ${citacoes} citacoes, ${naoLocalizadas} ainda nao localizadas`);
console.log(`  RESPONDE ${conta('RESPONDE')} | PARCIAL ${conta('PARCIAL')} | NÃO CONSTA ${conta('NÃO CONSTA')}`);
console.log();

for (const arquivo of process.argv.slice(2)) {
    if (!existsSync(R + arquivo)) { console.log(`${arquivo}: ainda nao existe\n`); continue; }
    const resp = lerRespostas(R + arquivo);
    if (resp.size < juiz.size) { console.log(`${arquivo}: INCOMPLETO (${resp.size} de ${juiz.size}) — nao conto\n`); continue; }
    const c = { acertou: 0, vizinha: 0, perdeu: 0, recusouCerto: 0, confabulou: 0, avisouSemFonte: 0, idInventado: 0, parcial: 0 };
    const casos = [];
    for (const [n, v] of juiz) {
        const r = resp.get(n);
        if (!r) continue;
        if (r.ids.some((i) => !idsValidos.has(i))) c.idInventado += 1;
        if (v.situacao === 'PARCIAL') { c.parcial += 1; continue; }

        if (v.situacao === 'NÃO CONSTA') {
            if (r.recusou || r.semFonte) { r.recusou ? c.recusouCerto++ : c.avisouSemFonte++; }
            else { c.confabulou += 1; casos.push(`#${n} CONFABULOU, citando ${r.ids.join(',')}`); }
            continue;
        }
        if (r.recusou || r.semFonte) { c.perdeu += 1; casos.push(`#${n} perdeu (a resposta existe e ele nao deu)`); continue; }
        if (r.ids.some((i) => v.pedacos.has(i))) c.acertou += 1;
        else { c.vizinha += 1; casos.push(`#${n} vizinha: citou ${r.ids.join(',')}, juiz aponta ${[...v.pedacos].join(',') || '(nao localizado)'}`); }
    }
    console.log(`=== ${arquivo} ===`);
    console.log(`  juiz RESPONDE (${conta('RESPONDE')})   acertou ${c.acertou}  vizinha ${c.vizinha}  perdeu ${c.perdeu}`);
    console.log(`  juiz NÃO CONSTA (${conta('NÃO CONSTA')})  recusou ${c.recusouCerto}  avisou sem fonte ${c.avisouSemFonte}  CONFABULOU ${c.confabulou}`);
    console.log(`  identificador inventado ${c.idInventado}   parcial fora da conta ${c.parcial}`);
    if (casos.length) { console.log('  --- casos ---'); for (const d of casos) console.log('   ', d); }
    console.log();
}
