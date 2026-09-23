// @ts-nocheck
/**
 * The prototype's component, ported rather than rewritten.
 *
 * Everything below is the prototype's own logic: the state, the drag, the
 * pane, the chips and their cards, the settings drawer, the copy. Three lines
 * changed — the base class, the ref factory, and where the registers come
 * from — and nothing else was touched.
 *
 * **`@ts-nocheck`, declared rather than discovered.** The fourth type-check
 * link runs the example under the same `strict` the sources get, and this file
 * is a thousand lines written without JSDoc, by a tool that did not have to
 * satisfy it. Annotating it would mean editing ported code line by line, which
 * is how a port stops being one. The cost is real and is the debt: a rename in
 * `dc.js` or in the registers will not fail here, it will fail in the browser.
 * Everything this file talks to — `dc.js`, `registers.js`, `bancada.js` — IS
 * checked, so the surface is narrow, but it is not nothing.
 */

import { DCLogic, createRef, React } from './dc.js';
import { DOCS, SOURCES, PAGE_TEXT } from './registers.js';

const CELADON = '#7ECF80';

/* These mirror the stylesheet: the card is measured in script and drawn by
   CSS, so the two have to agree on its width. */
const CARD_WIDTH = 256;   /* 16rem: wide enough for a passage, narrow enough to sit over a marker. */
const PANEL_WIDTH = 288;  /* 18rem: the overflow panel lists sources rather than quoting one. */
const CARD_EDGE = 12;
const COPY_KEYS = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘C' : 'Ctrl+C';
const CARD_HEIGHT = 150;
const PANEL_HEIGHT = 314;

/* 900px is where the two-column layout starts. Above this the document and
   the source panel share the screen; below it they take turns, because a
   column and a draggable divider are both unusable in the space that is
   left. */
const BREAK = 900;

export class Component extends DCLogic {
  state = {
    pane: 'library',      // 'library' | 'viewer'
    docKey: null,
    where: null,
    paneOpen: true,
    surface: 'text',      // celular: 'text' | 'pane'
    railW: 640,

    focused: false,
    /* Desligado: nada foi embutido ainda, e a nota ao lado do interruptor diz
       que nada sai da maquina — o que so' e' verdade se comecar assim. */
    semantic: false,
    typed: '',
    waiting: false,
    results: null,
    sourcesOpen: true,
    typedText: '',
    pending: false,
    file: null,
    attachOpen: false,
    urlFocused: false,
    settingsOpen: false,
    mode: 'sentence',
    mark: true,
    docKeys: Object.keys(DOCS),
    inputFocused: false,
    overflowOpen: false,
    overflowLeft: 0,
    overflowTop: 0,
    cardFor: null,
    cardPos: null,
    copied: false,
    flash: false,
    dim: false,
  };

  _paneRef = createRef();

  componentDidMount() {
    /* A click outside and an Escape both close it. Escape also clears the
       attachment, because undo is what that key means here. */
    this._onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (this.state.settingsOpen) this.setState({ settingsOpen: false });
      else if (this.state.attachOpen) this.setState({ attachOpen: false });
      else if (this.state.file) this.setState({ file: null });
    };
    this._onDown = (e) => {
      if (this.state.attachOpen && this._menu && !this._menu.contains(e.target)) {
        this.setState({ attachOpen: false });
      }
      /* A gaveta fecha como os outros véus: fora ou Escape. O header inteiro
         é a zona segura, porque a engrenagem mora nele. */
      if (this.state.settingsOpen && !e.target.closest('.fd-head')) {
        this.setState({ settingsOpen: false });
      }
    };
    window.addEventListener('keydown', this._onKey);
    document.addEventListener('mousedown', this._onDown, true);
    /* A largura é lida no render, não guardada: qualquer medição pós-montagem
       chega cedo demais e o runtime a descarta. Assim o primeiro render já
       nasce na largura que o host deu, sem janela para perder. */
    /* Card e painel são posicionados por medição, feita uma vez ao abrir:
       mudar a largura da coluna invalida a conta. Fechar é mais honesto que
       recalcular durante o arraste — reposicionar a cada quadro faria o card
       perseguir o ponteiro, e ninguém arrasta o divisor para ler o card. */
    this._onResize = () => {
      if (this.state.cardFor !== null || this.state.overflowOpen) {
        this.setState({ cardFor: null, cardPos: null, overflowOpen: false });
      }
      this.forceUpdate();
    };
    window.addEventListener('resize', this._onResize);
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this._onKey);
    document.removeEventListener('mousedown', this._onDown, true);
    window.removeEventListener('resize', this._onResize);
    /* Os tres que existem. `_waitT` e `_groundT` eram limpos aqui e nunca
       atribuidos em lugar nenhum: a espera e a fundamentacao deixaram de ter
       temporizador proprio — quem conta os 2,6s da mensagem e' a bancada, e o
       `pending` dura o que a chamada durar. Limpar um campo que ninguem
       escreve nao custa nada e diz ao leitor que ha' um quarto e um quinto
       temporizador em algum lugar. */
    clearTimeout(this._flashT);
    clearTimeout(this._copyT);
    clearTimeout(this._selT);
  }

  /* O chip não abre o documento: abre o card, como no Lucius Nihil. Quem
     leva ao documento é o "Open" dele. Um card só, posicionado por medição —
     oito cópias do mesmo markup seria o caminho caro. */
  /* Centred on the marker and clamped 12px inside the box that clips it. It
     slides horizontally and never flips to the other side: a card that
     changes sides makes the reader look for it. */
  clampLeft(triggerRect, boxRect, width) {
    let left = triggerRect.left + triggerRect.width / 2 - width / 2;
    left = Math.max(boxRect.left + CARD_EDGE, left);
    left = Math.min(boxRect.right - width - CARD_EDGE, left);
    return left;
  }

  openChip(n, e) {
    if (this.state.cardFor === n) { this.setState({ cardFor: null, cardPos: null }); return; }
    const btn = e.currentTarget;
    const r = btn.getBoundingClientRect();
    const doc = btn.closest('.fd-doc');
    const box = doc.getBoundingClientRect();
    /* Above the marker, always. When it does not fit there it is pushed back
       inside the scroller rather than allowed to leave the view: with the
       marker 20px from the top, 12 of its 145px remained visible, and a card
       that is 92% cut off is a click that does nothing. Near the top it rests
       against the marker itself. */
    const scEl = btn.closest('.fd-text').firstElementChild;
    const sc = scEl.getBoundingClientRect();
    /* Ancora pelo RODAPÉ, 8px acima do chip: com altura fixa, um card curto
       (fonte web, sem o trecho) ficaria flutuando longe do chip. O teto vem
       do espaço disponível, então ele encolhe em vez de sair da vista. */
    this.setState({
      cardFor: n, overflowOpen: false,
      /* Coordenadas relativas ao documento: rolar leva o card junto. */
      cardPos: {
        left: this.clampLeft(r, box, CARD_WIDTH) - box.left,
        bottom: box.bottom - r.top + 8,
        maxH: Math.max(96, r.top - sc.top - 16),
      },
    });
  }

  /* Abrir uma passagem: o documento entra já no lugar certo, e o contador
     acende — é aí que a pessoa quer saber onde caiu. */
  openSource(n) {
    const src = SOURCES.find(x => x.n === n);
    const href = src && DOCS[src.doc]?.url;
    if (href) { window.open(href, '_blank', 'noopener'); return; }
    const s = SOURCES.find(x => x.n === n) || SOURCES[0];
    const where = s.page !== undefined ? s.page : s.heading;
    this.setState({
      pane: 'viewer', docKey: s.doc, where,
      paneOpen: true, surface: 'pane', flash: true, results: null,
    });
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this.setState({ flash: false }), 900);
    /* O corpo da resposta e' desenhado uma vez e guardado, entao mudar o
       documento aberto nao acende sozinho o marcador correspondente. Quem
       redesenha e' a bancada, com o mesmo dado. */
    this.redrawBody?.();
  }

  openDoc(key, where) {
    const url = DOCS[key]?.url;
    if (url) { window.open(url, '_blank', 'noopener'); return; }
    this.setState({
      pane: 'viewer', docKey: key, where, paneOpen: true,
      surface: 'pane', flash: true, results: null,
    });
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this.setState({ flash: false }), 900);
    this.redrawBody?.();
  }

  /* Busca: uma pergunta por vez, e o resultado é a lista de passagens — o
     visor continua sendo um documento de cada vez. */
  /* Era uma lista fixa de quatro passagens. Agora pergunta ao indice: a
     coreografia — a espera so' quando ha' ida a rede — e' a mesma. */
  search = () => {
    const asked = this.state.typed;
    if (!asked || !asked.trim()) return;
    const dense = this.searchIsDense?.() === true;
    if (dense) this.setState({ waiting: true });
    Promise.resolve(this.runSearchText?.(asked))
      .catch((e) => this.report?.(e && e.message ? e.message : String(e)))
      .finally(() => { if (dense) this.setState({ waiting: false }); });
  };

  pageLines() {
    const { docKey, where } = this.state;
    const key = `${docKey}:${where}`;
    return PAGE_TEXT[key] || [];
  }

  /* A página do documento. createElement aqui porque é conteúdo de dado
     (linhas + trecho aceso), não layout da tela. */
  renderPage() {
    const { docKey } = this.state;
    const doc = DOCS[docKey];
    if (!doc) return null;
    const lines = this.pageLines();
    const isPaged = doc.pages !== undefined;

    const body = lines.map((ln, i) => {
      if (typeof ln === 'string') {
        return React.createElement('p', {
          key: i,
          style: { margin: '0 0 0.85rem', fontSize: isPaged ? '0.7rem' : '0.76rem', lineHeight: 1.9, color: isPaged ? '#d6d2c8' : '#8A8A95' },
        }, ln);
      }
      if (ln.h) {
        return React.createElement('h3', {
          key: i,
          style: { margin: '0 0 0.9rem', fontFamily: "'Jura', sans-serif", fontWeight: 400, fontSize: '0.95rem', letterSpacing: '0.04em', color: '#fff' },
        }, ln.h);
      }
      /* O parágrafo cuida do LAYOUT; o realce mora num span INLINE dentro
         dele. A versão anterior punha fundo, padding e anel no próprio `p`, e
         as três coisas juntas desenhavam uma caixa: o padding afastava a cor
         das letras, o anel fechava a moldura, e o bloco ia de margem a margem
         mesmo quando a última linha acabava no meio. Marca-texto para onde o
         texto para. */
      return React.createElement('p', {
        key: i,
        style: {
          margin: '0 0 0.85rem',
          fontSize: isPaged ? '0.7rem' : '0.76rem',
          lineHeight: 1.9,
        },
      }, React.createElement('span', {
        style: {
          /* `box-decoration-break: clone` é a peça que faz isto parecer caneta:
             sem ela, um trecho de três linhas recebe UM retângulo; com ela,
             cada linha ganha seu próprio fundo e termina onde o texto termina.
             O padding é em `em` e pequeno de propósito — dá o leve transbordo
             da tinta sem descolar a cor das letras. */
          background: 'rgba(126,207,128,0.3)',
          color: '#fff',
          padding: '0.15em 0.2em',
          borderRadius: '2px',
          boxDecorationBreak: 'clone',
          WebkitBoxDecorationBreak: 'clone',
        },
      }, ln.hl));
    });

    if (isPaged) {
      /* A graphite sheet, #15151b, rather than a white one. A lit white page in
         the middle of a dark screen is a lamp: the eye leaves the text and goes
         to the paper. */
      return React.createElement('div', {
        style: {
          maxWidth: '620px', margin: '0 auto', padding: '2.4rem 2.2rem',
          background: '#15151b', minHeight: '520px',
          boxShadow: '0 0 40px rgba(126,207,128,0.07)',
          animation: 'emerge 0.42s cubic-bezier(0.4,0,0.2,1)',
        },
      }, body);
    }

    /* MD e TXT: nós renderizamos, então não há página — só o texto. */
    return React.createElement('div', {
      style: { maxWidth: '620px', margin: '0 auto', animation: 'emerge 0.42s cubic-bezier(0.4,0,0.2,1)' },
    }, body);
  }

  /* Sources are grouped by document: pages of the same file become one row,
     never one row per passage. Four hits in one PDF are one source with four
     pages, and saying it the other way inflates what the answer rests on. */
  sourceRows() {
    const byDoc = new Map();
    SOURCES.forEach((s) => {
      const g = byDoc.get(s.doc);
      if (g) g.push(s);
      else byDoc.set(s.doc, [s]);
    });
    return [...byDoc.entries()].map(([key, list]) => {
      const d = DOCS[key];
      /* A pagina e' coordenada do visor e rotulo da citacao, e as duas coisas
         nao coincidem: um .txt e' uma peca so', e o visor precisa de um lugar
         para abrir enquanto a citacao nao tem pagina para dizer. Quem decide
         o rotulo e' o registro — `pages` so' existe em documento paginado —,
         que e' a mesma regra do contador embaixo do visor. */
      const pages = d.pages === undefined ? [] : list.filter(s => s.page !== undefined).map(s => s.page).sort((a, b) => a - b);
      const where = pages.length > 1 ? `pp. ${pages.join(', ')}` : pages.length === 1 ? `p. ${pages[0]}` : (list[0].heading || '');
      /* The name and the reference travel separately, and only the name
         truncates. A 150px cap applied to the whole row ate the page number,
         which is the part that IS the citation. */
      return {
        name: d.name,
        where,
        icon: d.cat === 'Web' ? this.globeIcon() : this.bookIcon(),
        open: () => this.openSource(list[0].n),
      };
    });
  }

  /* The icons are drawn here rather than imported: this page ships no icon
     package, and two shapes are cheaper than a dependency. */
  globeIcon() {
    return React.createElement('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'rgba(126,207,128,0.5)', strokeWidth: 1.6,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { width: '10px', height: '10px', flexShrink: 0 }, 'aria-hidden': 'true',
    }, React.createElement('circle', { key: 'c', cx: 12, cy: 12, r: 10 }),
       React.createElement('path', { key: 'm', d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }),
       React.createElement('path', { key: 'e', d: 'M2 12h20' }));
  }

  bookIcon() {
    return React.createElement('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'rgba(126,207,128,0.5)', strokeWidth: 1.6,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { width: '10px', height: '10px', flexShrink: 0 }, 'aria-hidden': 'true',
    }, React.createElement('path', { key: 'a', d: 'M12 7v14' }),
       React.createElement('path', { key: 'b', d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z' }));
  }

  /* Segmento da gaveta: retangular, borda de 1px que vira o acento quando é
     o escolhido — como os botões outline da casa. */
  seg(on) {
    return {
      padding: '0.4rem 0.8rem', lineHeight: 'normal',
      border: `1px solid ${on ? 'rgba(126,207,128,0.4)' : '#1A1A1F'}`,
      background: on ? 'rgba(126,207,128,0.08)' : 'none',
      color: on ? CELADON : '#8A8A95',
      fontFamily: "'JetBrains Mono', monospace", fontSize: '0.68rem',
      letterSpacing: '0.06em', cursor: 'pointer',
      transition: 'all 0.3s ease',
    };
  }

  /* O tracejado do trecho sem fonte, num lugar so': a bancada desenha o corpo
     da resposta e precisa da mesma marca que a tela promete nos ajustes. */
  unsupported() {
    return { borderBottom: '1px dashed #4A4A55', paddingBottom: '1px' };
  }

  chip(n, active) {
    return {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      /* A margem carrega o espaço que antecede o marcador: como texto solto
         ele sobrevivia ao `display: none` do modo parágrafo e deixava a
         pontuação órfã. Entre dois marcadores vai só o espaço — a vírgula do
         `, ` da biblioteca existe para separar colchetes na CÓPIA. */
      minWidth: '18px', height: '18px', padding: '0 4px', marginLeft: '0.32em',
      verticalAlign: 'text-bottom', borderRadius: '9999px',
      border: `1px solid ${active ? CELADON : '#1A1A1F'}`,
      background: active ? CELADON : '#0A0A0F',
      color: active ? '#050507' : 'rgba(126,207,128,0.7)',
      fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 500,
      letterSpacing: 0, whiteSpace: 'nowrap',
      cursor: 'pointer', transition: 'all 0.3s ease',
    };
  }

  activeN() {
    const { pane, docKey, where } = this.state;
    if (pane !== 'viewer') return null;
    const s = SOURCES.find(x => x.doc === docKey && (x.page === where || x.heading === where));
    return s ? s.n : null;
  }

  renderVals() {
    const st = this.state;
    const viewerOpen = st.pane === 'viewer' && !!st.docKey;
    const doc = DOCS[st.docKey];
    /* O acervo é estado, não constante: sem isso remover não removeria nada
       e o estado vazio seria inalcançável. */
    const docKeys = st.docKeys;
    const hasSources = docKeys.length > 0;
    /* 'paragraph' is one marker per block, and it claims the source was used
       somewhere inside it — a different promise from 'sentence', not a smaller
       number of markers. Both settings live in the drawer: as developer-only
       tweaks they would be controls nobody visiting the bench could reach. */
    const paragraphMode = st.mode === 'paragraph';

    const semanticAvailable = this.props.semanticAvailable ?? true;
    const markUnsupported = st.mark;

    /* O piso que estava no CSS vive aqui: 560px é o mínimo em que uma página
       A4 ainda se lê, e o teto deixa a coluna do texto respirar. */
    const paneW = Math.max(560, Math.min(st.railW, Math.max(560, window.innerWidth - 420)));
    const sourcePaneStyle = { width: st.paneOpen ? `${paneW}px` : 0 };

    const groups = ['Documents', 'Books', 'Web'].map(name => ({
      name,
      docs: docKeys.filter(k => DOCS[k].cat === name).map(k => {
        const d = DOCS[k];
        /* Era fixture: pagina 88 para o manual, 3 para o resto, 'web' para o
           que nao tinha pagina — coordenadas de documentos inventados. Aqui o
           ladrilho abre no comeco, e um documento sem paginas e' uma peca so',
           que mora na mesma coordenada 1 em que a bancada guarda o texto. */
        const first = 1;
        return {
          name: d.name, ext: d.ext,
          meta: d.pages !== undefined ? `${d.pages}p` : (d.ext === 'WEB' ? '—' : 'text'),
          open: () => this.openDoc(k, first),
          remove: (e) => {
            e.stopPropagation();
            /* Se o documento aberto é o que saiu, o visor fica sem lastro. */
            this.setState(s => ({ pane: s.docKey === k ? 'library' : s.pane }));
            /* Filtrar `docKeys` tirava o ladrilho e nada mais — o texto ficava
               no indice, no corpus e no armazenamento, e a proxima indexacao
               trazia o ladrilho de volta. Quem apaga e' a bancada, que refaz a
               prateleira a partir do que sobrou. */
            this.dropDoc?.(k);
          },
          /* Square: a document with no thumbnail reads as a shape, not as a card. */
          tileStyle: {
            display: 'flex', flexDirection: 'column', width: '72px',
            aspectRatio: '1 / 1', padding: 0,
            border: `1px solid ${st.docKey === k ? 'rgba(126,207,128,0.4)' : '#1A1A1F'}`,
            background: '#0A0A0F', cursor: 'pointer', overflow: 'hidden',
            transition: 'border-color 0.3s ease',
          },
        };
      }),
    })).filter(g => g.docs.length > 0);

    /* Em MD e TXT o cabeçalho da seção já está no próprio texto — repeti-lo
       aqui diria a mesma coisa duas vezes na mesma tela. */
    const position = doc && doc.pages !== undefined ? `${st.where} / ${doc.pages}` : '';

    return {
      viewerOpen,
      libraryVisible: !viewerOpen,
      surface: st.surface,
      paneState: st.paneOpen ? 'open' : 'closed',
      sourcePaneStyle,
      groups,
      docName: doc ? doc.name : '',
      docPosition: position,
      docCountLabel: hasSources ? `${docKeys.length} indexed` : 'none yet',
      pageBody: this.renderPage(),

      /* Repouso legível; esmaece ao descer lendo, acende ao trocar de página —
         é aí que a pessoa quer saber onde caiu. */
      counterStyle: {
        fontSize: '0.62rem', letterSpacing: '0.08em',
        color: st.flash ? CELADON : (st.dim ? '#4A4A55' : '#8A8A95'),
        transition: 'color 0.4s ease', whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },

      /* O visor rola aqui, então é ele que dita o esmaecer do contador. */
      onDocScroll: (e) => {
        const y = e.currentTarget.scrollTop;
        const down = y > (this._lastY || 0) + 6;
        const up = y < (this._lastY || 0) - 6;
        this._lastY = y;
        if (down && !st.dim) this.setState({ dim: true });
        else if (up && st.dim) this.setState({ dim: false });
      },

      /* Só a cor fica inline: a caixa e o `display` vivem em .fd-panebtn,
         senão o inline venceria o `display: none` da media query. */
      settingsOpen: st.settingsOpen,
      toggleSettings: () => this.setState({ settingsOpen: !st.settingsOpen }),
      gearStyle: {
        width: '30px', height: '30px', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', border: 'none', background: 'none',
        color: st.settingsOpen ? CELADON : '#4A4A55',
        cursor: 'pointer', transition: 'color 0.3s ease',
      },
      /* A granularidade vem da prop, mas a gaveta precisa mandar — o estado
         local vence quando a pessoa escolhe. */
      /* A densidade de marcador e' opcao da biblioteca, nao enfeite de tela:
         trocar o modo refaz a atribuicao no modo novo. Sem isso a legenda
         mudava e os marcadores ficavam onde estavam. */
      setSentence: () => { this.setState({ mode: 'sentence' }); this.regroundForMode?.(); },
      setParagraph: () => { this.setState({ mode: 'paragraph' }); this.regroundForMode?.(); },
      modeSentenceStyle: this.seg(!paragraphMode),
      modeParagraphStyle: this.seg(paragraphMode),
      modeNote: paragraphMode
        ? 'One marker per block: it says the source was used somewhere in the block.'
        : 'One marker per sentence: it says the source backs that sentence.',
      /* Marcar ou nao o trecho sem fonte e' desenho, nao atribuicao: a
         resposta nao muda, so' como ela e' pintada. Por isso redesenha em vez
         de reatribuir — e antes nao fazia nem uma coisa nem outra. */
      markOn: () => { this.setState({ mark: true }); this.redrawBody?.(); },
      markOff: () => { this.setState({ mark: false }); this.redrawBody?.(); },
      markOnStyle: this.seg(markUnsupported),
      markOffStyle: this.seg(!markUnsupported),

      paneBtnStyle: { color: st.paneOpen ? CELADON : '#4A4A55' },

      /* The card: 16rem, the source's name in small caps on the accent, the
         passage in three lines, and a full-width way into the document. */
      cardOpen: st.cardFor !== null,
      card: (() => {
        const s = SOURCES.find(x => x.n === st.cardFor);
        if (!s) return { name: '', line: '', where: '', isWeb: false };
        const d = DOCS[s.doc];
        const key = `${s.doc}:${s.page !== undefined ? s.page : s.heading}`;
        const hl = (PAGE_TEXT[key] || []).find(l => typeof l === 'object' && l.hl);
        return {
          name: d.name,
          /* Quarta casa da pagina inventada, e a mais lida das quatro: e' o
             card que se abre ao clicar um marcador. Quem decide se ha' pagina
             e' o registro, como no rodape de fontes e na linha do resultado —
             `s.page` e' coordenada do visor e existe sempre. */
          where: d.pages !== undefined && s.page !== undefined ? `p. ${s.page}` : (s.heading || ''),
          line: hl ? hl.hl : '',
          isWeb: d.cat === 'Web',
        };
      })(),
      /* Always above the marker: the vertical side is not a choice, and what
         keeps the card on screen is the horizontal clamp. */
      /* Ancorado por `bottom`, não por transform: o transform da animação
         venceria o do posicionamento e o card nasceria 145px abaixo.
         `border-box` porque, sem o reset do Tailwind, 16rem seria só o
         conteúdo — e o travamento reservaria 26px a menos que o real. */
      cardStyle: st.cardPos ? {
        position: 'absolute', left: `${st.cardPos.left}px`,
        bottom: `${st.cardPos.bottom}px`,
        maxHeight: `${st.cardPos.maxH}px`, overflowY: 'auto',
        boxSizing: 'border-box',
        width: '16rem', padding: '0.75rem', zIndex: 200,
        background: '#050507', border: '1px solid rgba(126,207,128,0.3)',
        boxShadow: '0 0 20px rgba(126,207,128,0.1)',
        animation: 'fdFade 0.15s ease',
      } : { display: 'none' },
      cardIcon: (() => {
        const s = SOURCES.find(x => x.n === st.cardFor);
        if (!s) return null;
        return DOCS[s.doc].cat === 'Web' ? this.globeIcon() : this.bookIcon();
      })(),
      /* `cardPos` sai junto com `cardFor`: quem decide se o card aparece e'
         a posicao, entao limpar so' o numero deixava um card em branco
         desenhado para sempre depois do primeiro marcador. */
      closeCard: () => this.setState({ cardFor: null, cardPos: null }),
      /* Fonte web sai do app: o botão precisa dizer isso. */
      cardBtnLabel: (() => {
        const src = SOURCES.find(x => x.n === st.cardFor);
        return src && DOCS[src.doc]?.url ? 'Open in browser' : 'Open';
      })(),
      openFromCard: () => { const n = st.cardFor; this.setState({ cardFor: null, cardPos: null }); this.openSource(n); },

      /* Three is the limit, and the slice is `MAX - 1`: from the fourth source
         on, TWO are shown and the rest go behind the +N. The last visible slot
         is spent on the counter, not on a source. */
      overflowStyle: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: '18px', padding: '0 6px', marginLeft: '0.32em',
        verticalAlign: 'text-bottom',
        fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
        borderRadius: '9999px', lineHeight: 'normal',
        border: `1px solid ${st.overflowOpen ? 'rgba(126,207,128,0.6)' : '#1A1A1F'}`,
        background: st.overflowOpen ? CELADON : '#0A0A0F',
        color: st.overflowOpen ? '#050507' : 'rgba(126,207,128,0.7)',
        cursor: 'pointer', transition: 'all 0.2s ease',
      },
      overflowOpen: st.overflowOpen,

      /* O repo abre para cima porque mede e reposiciona em tempo de abertura;
         portar só o `bottom: 100%` fazia o painel subir dentro de um scroller
         que corta. Escolho o lado ao abrir, comparando com a caixa da coluna. */
      /* Mesmo travamento do card, com a largura do painel: o `left: 0` fixo
         era o que deixava a borda comer o painel perto da margem. */
      overflowPanelStyle: {
        position: 'absolute', left: `${st.overflowLeft}px`,
        top: `${st.overflowTop}px`,
        zIndex: 140, width: '18rem',
        display: 'block', padding: '0.75rem', boxSizing: 'border-box',
        background: '#050507', border: '1px solid rgba(126,207,128,0.3)',
        boxShadow: '0 0 20px rgba(126,207,128,0.1)',
      },
      toggleOverflow: (e) => {
        if (st.overflowOpen) { this.setState({ overflowOpen: false }); return; }
        const btn = e.currentTarget;
        const r = btn.getBoundingClientRect();
        const box = btn.closest('.fd-doc').getBoundingClientRect();
        const scEl = btn.closest('.fd-text').firstElementChild;
        const sc = scEl.getBoundingClientRect();
        /* Mesma regra do card: acima, e só desce quando não há rolagem para
           cima. Depois é empurrado para dentro do scroller — com 314px de
           altura nenhum dos dois lados cabe no terço central. */
        let top = r.top - 8 - PANEL_HEIGHT;
        if (top < sc.top + 8 && scEl.scrollTop === 0) top = r.bottom + 8;
        top = Math.min(top, sc.bottom - 8 - PANEL_HEIGHT);
        top = Math.max(top, sc.top + 8);
        this.setState({
          overflowOpen: true, cardFor: null,
          /* Relativo ao gatilho, porque o painel é absoluto dentro dele. */
          overflowLeft: this.clampLeft(r, box, PANEL_WIDTH) - r.left,
          overflowTop: top - r.top,
        });
      },
      /* Cada item do +N é o mesmo corpo do card: domínio, título e Open. */
      overflowList: SOURCES.slice(2).map((s) => {
        /* Era [3, 4, 5] fixo, que eram as fontes do fixture. As de verdade
           sao as que sobram depois das duas primeiras, que e' o que o badge
           +N cobre. */
        const n = s.n;
        const d = DOCS[s.doc] || { name: s.doc, ext: '', cat: 'Documents' };
        const key = `${s.doc}:${s.page !== undefined ? s.page : s.heading}`;
        const hl = (PAGE_TEXT[key] || []).find(l => typeof l === 'object' && l.hl);
        return {
          n,
          name: d.name,
          where: s.page !== undefined ? `p. ${s.page}` : s.heading,
          line: hl ? hl.hl : '',
          icon: d.cat === 'Web' ? this.globeIcon() : this.bookIcon(),
          itemStyle: {
            display: 'block', padding: '0.5rem', marginBottom: '0.5rem',
            border: '1px solid #1A1A1F',
          },
          open: () => { this.setState({ overflowOpen: false }); this.openSource(n); },
        };
      }),

      /* A pilha: um bloco por envio, separado por fio — documento, não
         turno de conversa. */
      /* Era `true` fixo, porque o prototipo sempre tinha prosa. Agora o
         bloco so' existe depois que alguem fundamenta alguma coisa. */
      grounded: st.groundedBody != null,
      groundedBody: st.groundedBody,
      pending: st.pending,

      /* A column on the void, with a border that takes the accent on focus. No
         max width and no glow: it is the whole band. */
      inputBoxStyle: {
        display: 'flex', flexDirection: 'column',
        border: `1px solid ${st.inputFocused ? 'rgba(126,207,128,0.3)' : '#1A1A1F'}`,
        background: '#050507',
        transition: 'border-color 0.3s ease',
      },
      focusInput: () => this.setState({ inputFocused: true }),
      blurInput: () => this.setState({ inputFocused: false }),
      onInputText: (e) => {
        const el = e.currentTarget;
        el.style.height = 'auto';
        el.style.height = `${Math.min(200, el.scrollHeight)}px`;
        this.setState({ typedText: el.value });
      },

      /* The send control, filled with the accent. */
      groundSendStyle: {
        width: '32px', height: '32px', minWidth: '32px', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: st.typedText || st.file ? CELADON : '#1A1A1F',
        border: `1px solid ${st.typedText || st.file ? CELADON : '#1A1A1F'}`,
        color: st.typedText || st.file ? '#050507' : '#4A4A55',
        cursor: st.typedText || st.file ? 'pointer' : 'default', flexShrink: 0, lineHeight: 0,
        transition: 'background 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, color 0.2s ease',
      },
      groundRef: (el) => { this._input = el; },

      /* Uma origem só, então o + abre o seletor direto: menu de um item é
         ruído. Colar e anexar entregam a mesma coisa — um de cada vez, e o +
         recua enquanto há texto no campo. */
      fileRef: (el) => { this._file = el; },
      attachMenuRef: (el) => { this._menu = el; },
      attachOpen: st.attachOpen,
      /* The click toggles, and choosing an item closes the menu BEFORE the file
         picker opens — otherwise the menu is still painted behind the system
         dialog. Camera and image are inert here: this bench grounds text. */
      toggleAttach: () => {
        if (st.typedText || st.file) return;
        this.setState({ attachOpen: !st.attachOpen });
      },
      attachTitle: st.typedText
        ? 'Clear the text first — one source at a time.'
        : st.file ? 'Remove the attachment first — one source at a time.' : undefined,
      pickFile: () => { this.setState({ attachOpen: false }); this._file?.click(); },
      onFilePicked: (e) => {
        const f = e.currentTarget.files?.[0];
        /* O arquivo inteiro, e nao so' nome e tamanho: com o anexo no lugar o
           rodape passa a dizer "Ready to ground", e cumprir isso exige o
           conteudo. Guardava a etiqueta e jogava o arquivo fora, entao enviar
           so' o anexo fundamentava texto nenhum. */
        if (f) this.setState({ file: { name: f.name, size: f.size, blob: f } });
        e.currentTarget.value = '';
      },
      clearFile: () => this.setState({ file: null }),

      /* O "Add sources" da prateleira: um <label> com <input multiple> que
         abria o seletor do sistema e nao tinha ouvinte nenhum. A pessoa
         escolhia arquivos, o dialogo fechava e nada acontecia — que e' pior
         que um botao inerte, porque o gesto parece ter dado certo. */
      onSourcesPicked: (e) => {
        /* Copiada ANTES de limpar o campo, como o irmao `onFilePicked` faz:
           zerar o `value` esvazia a selecao do input, e uma `FileList` e' uma
           vista viva sobre ela em alguns navegadores. A copia responde a
           pergunta em vez de depender de qual deles esta rodando. */
        const chosen = [...(e.currentTarget.files ?? [])];
        e.currentTarget.value = '';
        if (chosen.length > 0) this.takeFiles?.(chosen);
      },
      hasFile: !!st.file,
      fileName: st.file ? st.file.name : '',
      fileMeta: st.file
        ? `${st.file.name.split('.').pop().toUpperCase()} · ${st.file.size >= 1024 ? Math.round(st.file.size / 1024) + ' KB' : st.file.size + ' B'}`
        : '',
      /* Sem fonte no acervo não há contra o que fundamentar: o campo fica
         mudo e diz o que falta, em vez de aceitar texto e não ter resposta. */
      hasSources: hasSources,
      groundDisabled: !hasSources,
      groundPlaceholder: !hasSources
        ? 'Add a source first'
        : st.file ? 'Ready to ground' : 'Paste text to ground',
      groundFieldStyle: {
        width: '100%', boxSizing: 'border-box', padding: '0.7rem 0.9rem 0.35rem',
        minHeight: '2.2rem', maxHeight: '200px', background: 'transparent',
        border: 0, outline: 'none', resize: 'none', overflowY: 'auto',
        color: hasSources ? '#fff' : '#4A4A55',
        fontFamily: "'JetBrains Mono', monospace", fontSize: '0.78rem', lineHeight: 1.35,
        cursor: hasSources ? 'text' : 'not-allowed',
      },
      attachStyle: {
        width: '28px', height: '28px', minWidth: '28px', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid transparent', background: 'none',
        color: st.typedText ? '#2A2A32' : '#4A4A55',
        cursor: st.typedText ? 'default' : 'pointer', lineHeight: 0,
        transition: 'color 0.2s ease, background 0.2s ease, border-color 0.2s ease',
      },
      pastedCloseStyle: {
        position: 'absolute', top: '4px', right: '4px',
        width: '18px', height: '18px', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        padding: 0, border: 'none', background: 'none', color: '#4A4A55',
        cursor: 'pointer',
      },
      scrollerRef: (el) => { this._scroller = el; },
      runGround: () => {
        if ((!st.typedText && !st.file) || st.pending) return;
        /* O textarea nao e controlado: zerar so o estado deixa o texto no DOM
           e o campo cresce vazio. E o que o composer do app faz ao enviar. */
        if (this._input) { this._input.value = ''; this._input.style.height = 'auto'; }
        const text = st.typedText;
        const attached = st.file?.blob ?? null;
        this.setState({ pending: true, typedText: '', file: null });
        /* Era um timeout de 1200ms fingindo trabalho. Agora e' o atribuidor,
           e o `pending` dura o que a chamada durar — com chave isso inclui a
           ida a rede, sem chave e' sincrono e o estado mal pisca. */
        Promise.resolve(this.runGroundText?.(text, attached))
          .catch((e) => this.report?.(e && e.message ? e.message : String(e)))
          .finally(() => {
            this.setState({ pending: false });
            /* Traz o bloco recem-nascido para a vista: sem isso o envio parece
               nao ter feito nada. */
            const sc = this._scroller;
            if (sc) setTimeout(() => { sc.scrollTop = sc.scrollHeight; }, 0);
          });
      },

      /* Sem fonte não é erro: marca quieta, tracejada. */
      unsupportedStyle: markUnsupported
        ? this.unsupported()
        : {},

      sourcesOpen: st.sourcesOpen,
      sourcesToggleLabel: `${this.sourceRows().length} Sources`,
      chevronStyle: {
        width: '12px', height: '12px',
        transform: st.sourcesOpen ? 'rotate(180deg)' : 'none',
        transition: 'transform 0.2s ease',
      },
      toggleSources: () => this.setState({ sourcesOpen: !st.sourcesOpen }),
      sourceList: this.sourceRows(),


      /* 26×26 with a 13px glyph: a muted grey that lights up under the pointer. */
      copyBtnStyle: {
        width: '26px', height: '26px', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        padding: 0, border: 'none', background: 'none',
        color: st.copied || st.selected ? CELADON : '#4A4A55',
        cursor: 'pointer', transition: 'color 0.2s ease',
      },
      copyTitle: st.copied ? 'Copied' : st.selected ? `Selected — ${COPY_KEYS}` : 'Copy with sources',
      /* Two glyphs for one control: the second confirms the copy happened. The
         stroke weights differ on purpose — 1.6 and 2 — because a check at 1.6
         reads as faint where the copy glyph reads as quiet. */
      copyIcon: st.copied
        ? React.createElement('svg', {
            viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            style: { width: '13px', height: '13px' }, 'aria-hidden': 'true',
          }, React.createElement('polyline', { points: '20 6 9 17 4 12' }))
        : React.createElement('svg', {
            viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            style: { width: '13px', height: '13px' }, 'aria-hidden': 'true',
          }, React.createElement('rect', { key: 'r', x: 9, y: 9, width: 12, height: 12, rx: 0 }),
             React.createElement('path', { key: 'p', d: 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' })),
      /* Copia de verdade: corpo com marcadores em colchetes + rodapé montado
         aqui, porque a biblioteca não conhece o nome do documento. Em iframe
         a API do clipboard é bloqueada, daí o execCommand como reserva — o
         mesmo caminho do chat. */
      copyAll: async () => {
        /* Era a resposta de exemplo do protótipo — cinco parágrafos sobre
           licitação, em inglês, com marcadores de [1] a [7]. Copiar entregava
           um texto que ninguém escreveu, citando fontes que não estavam na
           tela. O corpo vem da atribuição que produziu o que se esta' vendo, e
           sem nada fundamentado nao ha' o que copiar. */
        const body = this.groundedText?.();
        if (!body) return;
        /* So' as fontes que o texto cita. `SOURCES` e' o inventario completo —
           o numero do marcador e' a posicao nele, e por isso nada e'
           renumerado —, mas listar as nao citadas no rodape da copia sugere um
           lastro que o texto nao tem. No protótipo todas as sete apareciam no
           corpo; com atribuicao de verdade, a maioria nao aparece. */
        const cited = new Set([...body.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])));
        const refs = SOURCES.filter(s => cited.has(s.n)).map(s => `[${s.n}] ${s.label}`).join('\n');
        const text = `${body}\n\nSources:\n${refs}`;
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch { /* reserva */ }
        if (!ok) {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            ok = document.execCommand('copy');
            document.body.removeChild(ta);
          } catch { ok = false; }
        }
        /* Terceiro caminho, como no chat: quando a política do iframe barra
           as duas escritas, seleciona o bloco e diz o atalho — nunca não
           fazer nada, que era o defeito. */
        if (!ok) {
          const node = document.querySelector('.fd-block');
          try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(node);
            sel.removeAllRanges();
            sel.addRange(range);
            if (!sel.isCollapsed) {
              this.setState({ selected: true });
              clearTimeout(this._selT);
              this._selT = setTimeout(() => this.setState({ selected: false }), 4000);
            }
          } catch { /* sem seleção possível */ }
          return;
        }
        this.setState({ copied: true });
        clearTimeout(this._copyT);
        this._copyT = setTimeout(() => this.setState({ copied: false }), 1600);
      },

      /* Piso: abaixo disso uma página A4 deixa de ser legível e a coluna
         perde a razão de existir. */
      paneRef: this._paneRef,

      startDrag: (e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        this._drag = e.pointerId;
        this._dragW = st.railW;
        document.body.classList.add('fd-dragging');
        if (st.cardFor !== null || st.overflowOpen) {
          this.setState({ cardFor: null, cardPos: null, overflowOpen: false });
        }
      },

      /* A largura vai direto no nó, um quadro por vez — setState a cada
         movimento re-renderizaria a árvore inteira 144 vezes por segundo.
         O piso e o teto continuam valendo por min-width/max-width. */
      onDrag: (e) => {
        if (this._drag !== e.pointerId) return;
        this._dragW = Math.min(980, window.innerWidth - e.clientX);
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
          this._raf = 0;
          const el = this._paneRef.current;
          if (el) el.style.width = `${this._dragW}px`;
        });
      },

      /* Só ao soltar o React fica sabendo. */
      endDrag: (e) => {
        if (this._drag !== e.pointerId) return;
        this._drag = null;
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
        document.body.classList.remove('fd-dragging');
        this.setState({ railW: this._dragW });
      },
      togglePane: () => this.setState({ paneOpen: !st.paneOpen }),
      toPane: () => this.setState({ surface: 'pane' }),
      backToText: () => this.setState({ surface: 'text' }),
      closeViewer: () => this.setState({ pane: 'library' }),

      capTextStyle: this.capBtn(st.surface === 'text'),
      capLibStyle: this.capBtn(st.surface === 'pane'),
      capTextLabelStyle: this.capLabel(st.surface === 'text'),
      capLibLabelStyle: this.capLabel(st.surface === 'pane'),

      /* A column on the void: one border that takes the accent on focus. */
      composerStyle: {
        width: '100%', maxWidth: '560px', pointerEvents: 'auto',
        display: 'flex', flexDirection: 'column',
        border: `1px solid ${st.focused ? 'rgba(126,207,128,0.3)' : '#1A1A1F'}`,
        background: '#050507',
        boxShadow: st.focused ? '0 0 30px rgba(126,207,128,0.08)' : 'none',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
      },

      focusComposer: () => this.setState({ focused: true }),
      blurComposer: () => this.setState({ focused: false }),
      onComposerInput: (e) => {
        const el = e.currentTarget;
        el.style.height = 'auto';
        el.style.height = `${Math.min(200, el.scrollHeight)}px`;
        this.setState({ typed: el.value });
      },

      /* 32×32, filled, with a dark glyph over it: this is the primary action of
         the composer and the only filled control on the screen. */
      sendStyle: {
        width: '32px', height: '32px', minWidth: '32px', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: st.typed ? CELADON : '#1A1A1F',
        border: `1px solid ${st.typed ? CELADON : '#1A1A1F'}`,
        color: st.typed ? '#050507' : '#4A4A55',
        cursor: st.typed ? 'pointer' : 'default', flexShrink: 0, lineHeight: 0,
        transition: 'background 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, color 0.2s ease',
      },
      runSearch: this.search,

      /* O clique no botão tirava o foco do campo primeiro: a nota da chave
         desmontava, o balão encolhia, e o botão saía de baixo do ponteiro
         antes do clique fechar. Segurar o foco no mousedown resolve. */
      keepFocus: (e) => e.preventDefault(),

      /* Sem chave configurada a chave não aparece — nada de cadeado. */
      showConsequence: semanticAvailable && (st.focused || st.typed.length > 0),
      /* "Your documents", e nao "nada": a pagina busca as fontes do Google e,
         no primeiro PDF, o pdf.js de um CDN. Nenhuma das duas carrega material
         de quem usa — mas a frase antiga dizia que NADA saia, e com tres
         origens de terceiro no `<head>` isso era falso no sentido literal,
         numa bancada cujo assunto e' exatamente esse. O que a promessa
         protege e' o documento, e e' o documento que ela nomeia. */
      semanticNote: st.semantic
        ? 'Also finds passages that say the same thing in other words. Excerpts go to the provider; the document stays on your machine.'
        : 'Matches words only. Your documents stay on this machine.',
      /* Era so' a cor do ponto. Agora o interruptor e' o comando: ligar manda
         embutir o corpus, que e' a unica porta para o braco denso — e a nota
         ao lado passa a descrever o que de fato acontece. */
      toggleSemantic: () => {
        const on = !st.semantic;
        this.setState({ semantic: on });
        if (on) void this.turnOnMeaning?.();
      },
      knobStyle: {
        width: '8px', height: '8px', marginLeft: st.semantic ? '15px' : '2px',
        background: st.semantic ? CELADON : '#4A4A55',
        transition: 'margin-left 0.25s cubic-bezier(0.4,0,0.2,1), background 0.25s ease',
      },

      waiting: st.waiting,
      /* Era uma constante: as cinco escritas em `waitLabel` — as duas recusas
         daqui e as mensagens da bancada — chegavam ao estado e nenhuma chegava
         a' tela. A frase do protótipo passa a ser o que se diz quando nao ha
         nada mais especifico a dizer. */
      waitLabel: st.waitLabel ?? 'Comparing meaning',

      resultsOpen: !!st.results,
      results: (st.results || []).map(r => ({
        doc: DOCS[r.doc].name,
        /* Terceira casa da pagina inventada, depois do contador do visor e da
           linha da fonte: um documento sem paginas tem coordenada — o visor
           precisa de um lugar para abrir — e nao tem pagina para mostrar. O
           numero se esconde; heading e 'web', que sao texto, continuam. */
        where: DOCS[r.doc].pages !== undefined ? `p. ${r.where}` : (typeof r.where === 'number' ? '' : r.where),
        snippet: r.snippet,
        open: () => this.openDoc(r.doc, r.where),
      })),
      resultsHeading: 'Passages found',
      resultsCount: `${(st.results || []).length}`,
      closeResults: () => this.setState({ results: null }),
      stopClick: (e) => e.stopPropagation(),
    };
  }

  capBtn(on) {
    return {
      position: 'relative', height: '32px', minWidth: '40px', padding: '0 0.7rem',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      gap: '0.45rem', border: 'none', borderRadius: '2rem',
      background: on ? 'rgba(126,207,128,0.15)' : 'none',
      color: on ? '#fff' : '#4A4A55',
      fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer',
      transition: 'color 0.25s ease, background 0.25s ease',
    };
  }

  capLabel(on) {
    return {
      display: on ? 'inline' : 'none', fontSize: '0.6rem',
      letterSpacing: '0.14em', textTransform: 'uppercase', whiteSpace: 'nowrap',
    };
  }
}
