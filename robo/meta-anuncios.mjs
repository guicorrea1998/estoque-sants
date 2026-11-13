// Robô diário: lê gasto e conversas do Meta Ads e grava no Firebase do app.
// Roda no GitHub Actions (.github/workflows/robo-anuncios.yml).
//
// Secrets usados (Settings → Secrets and variables → Actions):
//   META_TOKEN   token do "usuário do sistema" do Gerenciador de Negócios (permissão ads_read)
//   FIREBASE_SA  conteúdo do JSON da conta de serviço do Firebase
//   CONTAS       lista das lojas, ex.: [{"uid":"abc123","conta":"155895457925948"}]
//
// Grava em usuarios/{uid}/anuncios/{AAAA-MM-DD}:
//   { data, plataforma:'meta', gasto, conversas, impressoes, cliques, atualizadoEm }
// e em usuarios/{uid}/meta/anuncios (situação da conta):
//   { saldo, saldoTexto, tipo:'pre'|'pos', aPagar, gastoTotal, limite, status, atualizadoEm }

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const VERSAO = process.env.META_API_VERSAO || 'v25.0';
const DIAS = Math.min(Math.max(parseInt(process.env.DIAS || '7', 10) || 7, 1), 395);
const SIMULAR = process.env.SIMULAR === '1'; // teste local sem chamar o Meta

// Ações que o Meta usa para "conversa por mensagem iniciada".
const ACOES_CONVERSA = [
  'onsite_conversion.messaging_conversation_started_7d',
  'messaging_conversation_started_7d',
];

function exigir(nome) {
  const v = process.env[nome];
  if (!v) { console.error(`Falta o secret ${nome}.`); process.exit(1); }
  return v;
}

function dataISO(d) { return d.toISOString().slice(0, 10); }

function periodo() {
  const ate = new Date();
  const de = new Date();
  de.setUTCDate(de.getUTCDate() - (DIAS - 1));
  return { since: dataISO(de), until: dataISO(ate) };
}

async function lerInsights(conta, token) {
  const id = String(conta).startsWith('act_') ? conta : `act_${conta}`;
  const params = new URLSearchParams({
    level: 'account',
    fields: 'spend,impressions,inline_link_clicks,actions',
    time_increment: '1',
    time_range: JSON.stringify(periodo()),
    limit: '500',
  });
  let url = `https://graph.facebook.com/${VERSAO}/${id}/insights?${params}`;
  const linhas = [];
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const corpo = await r.json();
    if (!r.ok || corpo.error) {
      const e = corpo.error || {};
      throw new Error(`Meta respondeu ${r.status}: ${e.message || 'erro'} (código ${e.code ?? '?'})`);
    }
    linhas.push(...(corpo.data || []));
    url = corpo.paging?.next || null;
  }
  return linhas;
}

// "Saldo disponível (R$ 45,30 BRL)" ou "Available balance (R$45.30 BRL)" -> 45.3
function lerValor(texto) {
  const m = String(texto || '').match(/(?:R\$|BRL)\s*([\d.,]+)/) || String(texto || '').match(/([\d][\d.,]*)/);
  if (!m) return null;
  let n = m[1];
  const ult = Math.max(n.lastIndexOf(','), n.lastIndexOf('.'));
  if (ult >= 0 && n.length - ult - 1 === 2) n = n.slice(0, ult).replace(/[.,]/g, '') + '.' + n.slice(ult + 1);
  else n = n.replace(/[.,]/g, '');
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

// Situação da conta: saldo pré-pago (Pix/boleto) ou valor a pagar (cartão).
async function lerConta(conta, token) {
  const id = String(conta).startsWith('act_') ? conta : `act_${conta}`;
  const campos = 'name,currency,account_status,amount_spent,balance,spend_cap,funding_source_details';
  const r = await fetch(`https://graph.facebook.com/${VERSAO}/${id}?fields=${campos}`, { headers: { Authorization: `Bearer ${token}` } });
  const c = await r.json();
  if (!r.ok || c.error) { const e = c.error || {}; throw new Error(`Meta respondeu ${r.status}: ${e.message || 'erro'} (código ${e.code ?? '?'})`); }
  return converterConta(c);
}

function converterConta(c) {
  const fonte = c.funding_source_details || {};
  const texto = fonte.display_string || '';
  const pre = fonte.type === 20 || /dispon|available|pré-pago|prepaid/i.test(texto);
  const cent = v => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)) / 100);
  const limite = cent(c.spend_cap);
  return {
    tipo: pre ? 'pre' : 'pos',
    saldo: pre ? lerValor(texto) : null,
    saldoTexto: texto,
    aPagar: pre ? null : cent(c.balance),
    gastoTotal: cent(c.amount_spent),
    limite: limite || null,
    status: Number(c.account_status) || null,   // 1 ativa, 2 desativada, 3 pagamento pendente...
    moeda: c.currency || 'BRL',
  };
}

function converter(l) {
  const acoes = l.actions || [];
  const conversas = acoes
    .filter(a => ACOES_CONVERSA.includes(a.action_type))
    .reduce((m, a) => Math.max(m, Number(a.value) || 0), 0);
  return {
    data: l.date_start,
    plataforma: 'meta',
    gasto: Math.round((Number(l.spend) || 0) * 100) / 100,
    conversas,
    impressoes: Number(l.impressions) || 0,
    cliques: Number(l.inline_link_clicks) || 0,
  };
}

function simulado() {
  const { since } = periodo();
  const linhas = [];
  for (let i = 0; i < DIAS; i++) {
    const d = new Date(since + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
    linhas.push({ date_start: dataISO(d), spend: '7.00', impressions: '540', inline_link_clicks: '4',
      actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(i % 3) }] });
  }
  return linhas;
}

async function main() {
  // Enquanto os Secrets não forem cadastrados, só avisa e sai sem erro.
  if (!process.env.CONTAS || (!SIMULAR && !process.env.META_TOKEN) || !process.env.FIREBASE_SA) {
    console.log('Robô ainda não configurado: cadastre os secrets META_TOKEN, FIREBASE_SA e CONTAS. Nada foi feito.');
    return;
  }
  const contas = JSON.parse(exigir('CONTAS'));
  const token = SIMULAR ? '' : exigir('META_TOKEN');
  const sa = JSON.parse(exigir('FIREBASE_SA'));
  initializeApp({ credential: cert(sa) });
  const db = getFirestore();

  let falhas = 0;
  for (const { uid, conta, nome } of contas) {
    const rotulo = nome || conta;
    try {
      const linhas = SIMULAR ? simulado() : await lerInsights(conta, token);
      const lote = db.batch();
      for (const l of linhas) {
        const dia = converter(l);
        lote.set(db.doc(`usuarios/${uid}/anuncios/${dia.data}`),
          { ...dia, atualizadoEm: new Date().toISOString() }, { merge: true });
      }
      await lote.commit();
      const situacao = SIMULAR ? converterConta({ funding_source_details: { type: 20, display_string: 'Saldo disponível (R$ 45,30 BRL)' }, amount_spent: '123456', account_status: 1, currency: 'BRL' })
        : await lerConta(conta, token);
      await db.doc(`usuarios/${uid}/meta/anuncios`).set({ ...situacao, atualizadoEm: new Date().toISOString() });
      console.log(`  saldo: ${situacao.tipo === 'pre' ? 'R$ ' + (situacao.saldo ?? '?') : 'a pagar R$ ' + (situacao.aPagar ?? '?')}`);
      const gasto = linhas.reduce((s, l) => s + (Number(l.spend) || 0), 0);
      console.log(`✓ ${rotulo}: ${linhas.length} dia(s) com gasto gravados (R$ ${gasto.toFixed(2)} nos últimos ${DIAS} dias).`);
    } catch (e) {
      falhas++;
      console.error(`✗ ${rotulo}: ${e.message}`);
    }
  }
  if (falhas) process.exit(1);
}

export { lerInsights, converter, periodo, lerValor, converterConta };
if (import.meta.url === `file://${process.argv[1]}`) main();
