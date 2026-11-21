import { useCallback, useEffect, useRef, useState } from 'react';
import nacl from 'nacl';
import QRCode from 'qrcode';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Blocks, Check, ChevronDown,
  ChevronUp, CircleAlert, Copy, Cpu, FileKey2, Fingerprint, Gauge, Globe2, HardDrive,
  KeyRound, Link2, LockKeyhole, Pickaxe, Plus, Radio, RefreshCw, Search, ShieldCheck,
  Sparkles, Wallet, X, QrCode, BookUser, Trash2, Download, Upload, Lock, UserRound,
  ChevronRight
} from 'lucide-react';
import {
  createEncryptedWallet,
  decryptWallet,
  LEGACY_STORAGE_KEY,
  migrateLegacyWallet,
  OLD_LEGACY_STORAGE_KEY,
  OLD_VAULT_STORAGE_KEY,
  readWalletState,
  signWithVault,
  VAULT_STORAGE_KEY,
  wipeLegacyWallet,
  writeEncryptedWallet
} from './walletVault.js';
import {
  COIN,
  MAX_SUPPLY,
  MIN_AMOUNT_UNITS as MIN_AMOUNT,
  MIN_FEE_UNITS as MIN_FEE,
  formatAtomic,
  parseAmountUnits,
  parseFeeUnits
} from './amounts.js';

const HALVING_INTERVAL = 210_000;
const NETWORK_ID = 'BNKR-MAINNET-V1';
const CONTACTS_KEY = 'bnkr.contacts.v1';
const QUICKSTART_KEY = 'bnkr.quickstart.dismissed';
const OLD_CONTACTS_KEY = 'blkc.contacts.v1';
const OLD_QUICKSTART_KEY = 'blkc.quickstart.dismissed';

function migrateStorageKey(newKey, oldKey) {
  try {
    const next = localStorage.getItem(newKey);
    if (next != null) return;
    const old = localStorage.getItem(oldKey);
    if (old != null) {
      localStorage.setItem(newKey, old);
      localStorage.removeItem(oldKey);
    }
  } catch {
    // ignore storage migration failures
  }
}

function amount(units) {
  const value = Number(units || 0);
  const whole = Math.floor(value / COIN);
  const fraction = String(value % COIN).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function short(value, first = 8, last = 6) {
  if (!value) return '—';
  return value.length > first + last + 3 ? `${value.slice(0, first)}…${value.slice(-last)}` : value;
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function initializeWallet() {
  migrateStorageKey(VAULT_STORAGE_KEY, OLD_VAULT_STORAGE_KEY);
  migrateStorageKey(LEGACY_STORAGE_KEY, OLD_LEGACY_STORAGE_KEY);
  try {
    return { ...readWalletState(), initialError: null };
  } catch (error) {
    return { wallet: null, vault: null, needsMigration: false, initialError: error.message };
  }
}

function readContacts() {
  migrateStorageKey(CONTACTS_KEY, OLD_CONTACTS_KEY);
  try {
    const value = JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]');
    return Array.isArray(value) ? value.filter(contact =>
      typeof contact?.name === 'string' && typeof contact?.address === 'string'
    ) : [];
  } catch {
    return [];
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }
    });
  } catch (error) {
    const networkError = new Error('Unable to reach the node. Check your connection and try again.');
    networkError.status = 0;
    networkError.cause = error;
    throw networkError;
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function IconButton({ icon: Icon, children, ...props }) {
  return <button className="quiet-button inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium" {...props}>
    <Icon size={14} />{children}
  </button>;
}

function SectionTitle({ icon: Icon, title, detail, action }) {
  return <div className="mb-5 flex items-center justify-between gap-3">
    <div className="flex items-center gap-3">
      <div className="rounded-lg border border-[#d4af3726] bg-[#d4af370b] p-2 text-gold"><Icon size={16} /></div>
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-[#eee9dc]">{title}</h2>
        {detail && <p className="mt-1 text-[11px] text-[#77756e]">{detail}</p>}
      </div>
    </div>
    {action}
  </div>;
}

function Modal({ title, children, onClose }) {
  useEffect(() => {
    const onKey = event => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-label={title} className="glass-card scrollbar max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl p-6 sm:p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div><p className="text-[10px] uppercase tracking-[.25em] text-gold">The Handsome Devil · Protocol</p><h2 className="mt-2 font-display text-3xl text-[#f0e9d7]">{title}</h2></div>
        <button aria-label="Close dialog" className="rounded-lg p-2 text-[#77756e] hover:bg-white/5 hover:text-white" onClick={onClose}><X size={18} /></button>
      </div>
      {children}
    </div>
  </div>;
}

function makePayload(sender, recipient, amount, nonce) {
  return {
    sender,
    recipient,
    amount,
    fee: formatAtomic(MIN_FEE),
    nonce,
    timestamp: Date.now()
  };
}

function signingMessage(payload) {
  const amountUnits = parseAmountUnits(payload.amount);
  const feeUnits = parseFeeUnits(payload.fee);
  return JSON.stringify([
    NETWORK_ID,
    payload.sender,
    payload.recipient,
    String(amountUnits),
    String(feeUnits),
    payload.nonce,
    payload.timestamp
  ]);
}

export default function App() {
  const [initial] = useState(initializeWallet);
  const [wallet, setWallet] = useState(initial.wallet);
  const [state, setState] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [totalBlocks, setTotalBlocks] = useState(0);
  const [mempool, setMempool] = useState([]);
  const [verified, setVerified] = useState(null);
  const [vault, setVault] = useState(initial.vault);
  const [needsMigration, setNeedsMigration] = useState(initial.needsMigration);
  const [pendingWallet, setPendingWallet] = useState(null);
  const [signRequest, setSignRequest] = useState(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [minerOn, setMinerOn] = useState(false);
  const [hashRate, setHashRate] = useState(0);
  const [minerNonce, setMinerNonce] = useState(0);
  const [activity, setActivity] = useState(['Node ready. Waiting for miner input.']);
  const [modal, setModal] = useState(null);
  const [recipient, setRecipient] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [peerUrl, setPeerUrl] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const workerRef = useRef(null);
  const miningRef = useRef(false);
  const searchTimer = useRef(null);

  useEffect(() => {
    migrateStorageKey(QUICKSTART_KEY, OLD_QUICKSTART_KEY);
  }, []);

  useEffect(() => {
    if (needsMigration) setModal('migrate');
  }, [needsMigration]);

  const notify = useCallback((message, kind = 'success') => {
    setNotice({ message, kind });
    window.clearTimeout(notify.timeout);
    notify.timeout = window.setTimeout(() => setNotice(null), 4200);
  }, []);

  useEffect(() => {
    if (initial.initialError) notify(initial.initialError, 'error');
  }, [initial.initialError, notify]);

  const refresh = useCallback(async (opts = {}) => {
    const { silent = false } = opts;
    try {
      const [network, pool, result] = await Promise.all([
        request(`/api/state${wallet ? `?address=${encodeURIComponent(wallet.publicKey)}` : ''}`),
        request('/api/mempool'),
        request('/api/validate')
      ]);
      setState(network);
      setMempool(pool.transactions || []);
      setVerified(result.valid);
    } catch (error) {
      const status = error?.status;
      const message = String(error?.message || '');
      const transient = status === 0 || status === 403 || status === 429 ||
        /banned|rate limit|too many requests|temporarily unavailable|unable to reach/i.test(message);
      if (transient) {
        if (!silent) {
          const notice = status === 429 || /rate limit|too many requests/i.test(message)
            ? 'Rate limit reached. Please wait a moment and try again.'
            : /banned/i.test(message)
              ? error.message
              : 'Connection issue. Retrying automatically; wallet balances are unchanged.';
          notify(notice, 'error');
        }
        return;
      }
      setVerified(false);
      if (!silent) notify(error.message, 'error');
    }
  }, [wallet, notify]);

  const loadBlocks = useCallback(async (nextPage = page, query = search) => {
    try {
      const result = await request(`/api/blocks?limit=25&offset=${nextPage * 25}&search=${encodeURIComponent(query)}`);
      setBlocks(result.blocks);
      setTotalBlocks(result.total);
      setPage(nextPage);
    } catch (error) {
      notify(error.message, 'error');
    }
  }, [notify, page, search]);

  useEffect(() => {
    void refresh();
    void loadBlocks(0, '');
    const interval = window.setInterval(() => {
      void refresh({ silent: true });
      void loadBlocks(page, search);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refresh, loadBlocks, page, search]);

  useEffect(() => {
    miningRef.current = minerOn;
    if (!minerOn || !wallet) {
      workerRef.current?.terminate();
      workerRef.current = null;
      setHashRate(0);
      return undefined;
    }
    let cancelled = false;
    const worker = new Worker(new URL('./miner.worker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    const startRound = async () => {
      try {
        const template = await request(`/api/mining/template?miner=${encodeURIComponent(wallet.publicKey)}`);
        if (cancelled || !miningRef.current) return;
        worker.postMessage({ type: 'start', template });
        setActivity(log => [`Mining block ${template.height} · difficulty ${template.difficulty}`, ...log].slice(0, 8));
      } catch (error) {
        setActivity(log => [`Miner stopped: ${error.message}`, ...log].slice(0, 8));
        setMinerOn(false);
      }
    };

    worker.onmessage = async event => {
      if (event.data.type === 'progress') {
        setHashRate(event.data.hashesPerSecond);
        setMinerNonce(event.data.nonce);
      }
      if (event.data.type === 'found') {
        setActivity(log => [`Proof found at nonce ${event.data.block.nonce} · submitting block`, ...log].slice(0, 8));
        try {
          const result = await request('/api/mining/submit', {
            method: 'POST',
            body: JSON.stringify(event.data.block)
          });
          setActivity(log => [`Block ${result.height} confirmed · ${event.data.block.hash.slice(0, 16)}…`, ...log].slice(0, 8));
          await refresh();
          if (!cancelled && miningRef.current) {
            await new Promise(r => setTimeout(r, 2000));
            void startRound();
          }
        } catch (error) {
          setActivity(log => [`Share rejected: ${error.message}`, ...log].slice(0, 8));
          if (!cancelled && miningRef.current) {
            await new Promise(r => setTimeout(r, 2000));
            void startRound();
          }
        }
      }
    };
    worker.onerror = event => {
      setActivity(log => [`Miner worker error: ${event.message}`, ...log].slice(0, 8));
      setMinerOn(false);
    };
    void startRound();
    return () => {
      cancelled = true;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [minerOn, wallet, refresh]);

  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

  // No raw secret key is ever persisted. Creation and import stage the secret
  // only until the operator supplies a password, then it is encrypted and the
  // in-memory copy is zeroed.
  const beginCreateWallet = () => {
    const pair = nacl.sign.keyPair();
    setPendingWallet({ secretKey: pair.secretKey, publicKey: encodeBase64(pair.publicKey), mode: 'create' });
    setModal('password');
  };

  const beginImportWallet = value => {
    try {
      const secret = decodeBase64(value.trim());
      if (secret.length !== nacl.sign.secretKeyLength) throw new Error('Expected a 64-byte Ed25519 secret key.');
      const pair = nacl.sign.keyPair.fromSecretKey(secret);
      setPendingWallet({ secretKey: secret, publicKey: encodeBase64(pair.publicKey), mode: 'import' });
      setModal('password');
    } catch (error) {
      notify(error.message || 'Private key could not be imported.', 'error');
    }
  };

  const protectPendingWallet = async password => {
    if (!pendingWallet) throw new Error('No wallet is waiting to be protected.');
    const { secretKey, publicKey, mode } = pendingWallet;
    const nextVault = await createEncryptedWallet(secretKey, password);
    writeEncryptedWallet(nextVault);
    wipeLegacyWallet();
    secretKey.fill(0);
    setVault(nextVault);
    setWallet({ publicKey, protected: true, legacy: false });
    setPendingWallet(null);
    setNeedsMigration(false);
    notify(mode === 'import'
      ? 'Wallet restored and encrypted with your password.'
      : 'Encrypted wallet generated. Download the vault backup.');
  };

  const protectLegacyWallet = async password => {
    const migrated = await migrateLegacyWallet(password);
    if (!migrated) throw new Error('The legacy wallet entry is no longer present.');
    setVault(migrated.vault);
    setWallet({ publicKey: migrated.publicKey, protected: true, legacy: false });
    setNeedsMigration(false);
    notify('Legacy wallet encrypted; plaintext key removed from this browser.');
  };

  const copy = async value => {
    try {
      await navigator.clipboard.writeText(value);
      notify('Copied to clipboard.');
    } catch {
      notify('Clipboard access is unavailable in this browser.', 'error');
    }
  };

  const downloadBackup = (name, content) => {
    try {
      const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      notify('Backup file downloaded.');
    } catch (error) {
      notify('Failed to generate backup file.', 'error');
    }
  };

  const send = async event => {
    event.preventDefault();
    if (!wallet || busy) return;
    if (needsMigration || !vault) {
      setNeedsMigration(true);
      setModal('migrate');
      notify('Set a wallet password before sending a transaction.', 'error');
      return;
    }
    setBusy(true);
    try {
      const normalizedAmount = String(sendAmount || '').trim();
      const normalizedRecipient = String(recipient || '').trim();
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(normalizedAmount) || Number(normalizedAmount) <= 0) {
        throw new Error('Enter a positive amount with up to 8 decimal places.');
      }
      const amountUnits = parseAmountUnits(normalizedAmount);
      const amount = formatAtomic(amountUnits);
      const [freshState, freshPool] = await Promise.all([
        request(`/api/state?address=${encodeURIComponent(wallet.publicKey)}`),
        request('/api/mempool')
      ]);
      const pending = (freshPool.transactions || []).filter(tx => tx.sender === wallet.publicKey);
      const nextNonce = Number(freshState.nonce || 0) + pending.length + 1;
      const payload = makePayload(wallet.publicKey, normalizedRecipient, amount, nextNonce);
      setSignRequest({ payload });
      setModal('sign');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Signing decrypts the vault only for this operation; the secret is zeroed by
  // signWithVault and never placed in component state or localStorage.
  const confirmSign = async password => {
    if (!signRequest || !vault) return;
    setBusy(true);
    try {
      const signature = await signWithVault(
        vault,
        password,
        new TextEncoder().encode(signingMessage(signRequest.payload))
      );
      await request('/api/tx', {
        method: 'POST',
        body: JSON.stringify({ ...signRequest.payload, signature: encodeBase64(signature) })
      });
      setRecipient('');
      setSendAmount('');
      setSignRequest(null);
      notify('Signed transfer broadcast to the mempool.');
      await refresh();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addPeer = async event => {
    event.preventDefault();
    try {
      const result = await request('/api/peers', { method: 'POST', body: JSON.stringify({ url: peerUrl }) });
      setPeerUrl('');
      setState(current => current ? { ...current, peers: result.peers } : current);
      notify('Peer connected and synchronization started.');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const validateNow = async () => {
    try {
      const result = await request('/api/validate');
      setVerified(result.valid);
      notify(result.valid ? `Chain verified through block ${result.height}.` : result.error, result.valid ? 'success' : 'error');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const pageCount = Math.max(1, Math.ceil(totalBlocks / 25));
  const supplyPercent = Math.min(100, ((state?.supply || 0) / MAX_SUPPLY) * 100);
  const latest = state?.latestBlock;

  return <div className="min-h-screen bg-obsidian">
    <header className="border-b border-white/[.06]">
      <div className="mx-auto max-w-[1440px] px-5 py-5 sm:px-8 lg:px-12">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-4">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-full border border-gold/60 bg-[#d4af370b] text-gold">
              <span className="font-display text-2xl font-semibold">B</span><span className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-obsidian bg-gold" />
            </div>
            <div><p className="font-display text-xl font-semibold tracking-[.09em] text-[#eee8d8]">THE BANNEKER COIN</p><p className="mt-0.5 text-[9px] uppercase tracking-[.25em] text-[#77756e]">An open monetary protocol <span className="px-1 text-gold">·</span> BNKR</p></div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setModal('whitepaper')} className="quiet-button inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs"><FileKey2 size={14} /> Whitepaper</button>
            {wallet ? <button onClick={() => setModal('keys')} className="inline-flex items-center gap-2 rounded-lg border border-[#d4af3733] bg-[#d4af370b] px-3 py-2.5 text-xs text-gold"><Fingerprint size={14} /> Wallet <span className="mono text-[#a8a397]">{short(wallet.publicKey)}</span></button> :
              <button onClick={() => setModal('wallet')} className="gold-button inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold"><Plus size={14} /> Generate Wallet</button>}
          </div>
        </div>
      </div>
    </header>

    <main className="mx-auto max-w-[1440px] px-5 pb-16 pt-8 sm:px-8 lg:px-12">
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Telemetry label="Circulating supply" icon={Activity} value={`${amount(state?.supply || 0)} / 21M`} detail="BNKR issued" wide />
        <Telemetry label="Block height" icon={Blocks} value={state?.height?.toLocaleString() ?? '—'} detail="latest confirmed" />
        <Telemetry label="Block reward" icon={Sparkles} value={`${amount(state?.reward || 0)}`} detail="BNKR / block" />
        <Telemetry label="Difficulty" icon={Gauge} value={state?.difficulty ?? '—'} detail="leading hex zeroes" />
        <button onClick={validateNow} className="glass-card col-span-2 flex min-h-[92px] items-center justify-between rounded-xl px-4 text-left transition hover:border-gold/40 sm:col-span-1">
          <div><p className="text-[9px] uppercase tracking-[.17em] text-[#77756e]">Integrity check</p><div className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${verified ? 'text-emerald-400' : 'text-red-400'}`}>{verified ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}{verified === null ? 'Checking…' : verified ? 'Chain Verified ✓' : 'Chain Invalid'}</div></div><RefreshCw size={14} className="text-[#77756e]" />
        </button>
        <Telemetry label="Connected peers" icon={Globe2} value={state?.peers?.length ?? '0'} detail="node connections" />
      </section>

      <div className="mb-8 grid gap-3 sm:grid-cols-2">
        <div className="glass-card rounded-xl p-4">
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[.14em] text-[#77756e]"><span>21,000,000 BNKR hard cap</span><span>{supplyPercent.toFixed(5)}%</span></div>
          <div className="h-1 overflow-hidden rounded-full bg-[#24221c]"><div className="h-full rounded-full bg-gradient-to-r from-[#9f7d1c] to-gold transition-[width]" style={{ width: `${supplyPercent}%` }} /></div>
        </div>
        <div className="glass-card flex items-center justify-between gap-4 rounded-xl px-4 py-3">
          <div><p className="text-[10px] uppercase tracking-[.14em] text-[#77756e]">Next halving</p><p className="mono mt-1 text-xs text-[#e2dbc8]">{HALVING_INTERVAL.toLocaleString()} block intervals</p></div>
          <p className="flex items-center gap-2 text-[10px] text-[#77756e]"><Radio size={13} className="text-gold" /> Target block time <span className="mono text-[#c8bfaa]">15 sec</span></p>
        </div>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(390px,.92fr)]">
        <section className="space-y-5">
          <div className="glass-card rounded-2xl p-5 sm:p-6">
            <SectionTitle icon={Wallet} title="Anonymous Wallet" detail="Non-custodial · secret key encrypted in this browser with your password" />
            {needsMigration && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/[.06] px-4 py-3 text-xs text-amber-200">
              <span>An unencrypted legacy wallet was found in this browser. Set a password to encrypt it and delete the plaintext key.</span>
              <button onClick={() => setModal('migrate')} className="gold-button rounded-lg px-3 py-2 text-xs font-semibold">Secure it now</button>
            </div>}
            {wallet ? <>
              <div className="rounded-xl border border-white/[.07] bg-black/20 p-4">
                <div className="mb-2 flex items-center justify-between"><span className="text-[10px] uppercase tracking-[.15em] text-[#77756e]">Public address</span><button aria-label="Copy wallet address" className="text-[#8f8b80] hover:text-gold" onClick={() => void copy(wallet.publicKey)}><Copy size={14} /></button></div>
                <p className="mono break-all text-xs leading-6 text-[#ddd6c5]">{wallet.publicKey}</p>
                <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-white/[.06] pt-4">
                  <div><p className="text-[10px] uppercase tracking-[.15em] text-[#77756e]">Confirmed balance</p><p className="mt-1 font-display text-3xl text-[#eee4ca]">{amount(state?.balance || 0)} <span className="text-base text-gold">BNKR</span></p></div>
                  <div className="flex flex-wrap gap-2"><IconButton icon={ArrowDownToLine} onClick={() => setModal('export')}>Export Key</IconButton><IconButton icon={KeyRound} onClick={() => setModal('import')}>Import Key</IconButton></div>
                </div>
              </div>
              <form className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_130px_auto]" onSubmit={send}>
                <label className="block"><span className="mb-2 block text-[10px] uppercase tracking-[.12em] text-[#77756e]">Recipient public address</span><input className="field rounded-lg px-3 py-3 text-xs" placeholder="Base64 Ed25519 public key" value={recipient} onChange={event => setRecipient(event.target.value)} required /></label>
                <label className="block"><span className="mb-2 block text-[10px] uppercase tracking-[.12em] text-[#77756e]">Amount · BNKR</span><input className="field rounded-lg px-3 py-3 text-xs" inputMode="decimal" placeholder="0.00000000" value={sendAmount} onChange={event => setSendAmount(event.target.value)} required /></label>
                <button disabled={busy || !state} className="gold-button mt-auto inline-flex h-[42px] items-center justify-center gap-2 rounded-lg px-4 text-xs font-semibold"><ArrowUpRight size={14} />{busy ? 'Signing…' : 'Send BNKR'}</button>
              </form>
              <p className="mt-3 flex items-start gap-2 text-[10px] leading-5 text-[#77756e]"><LockKeyhole size={12} className="mt-0.5 shrink-0 text-gold/70" />Transactions are signed locally after you enter your password. Your private key is never submitted to the node or stored in plaintext.</p>
            </> : <div className="rounded-xl border border-dashed border-[#39352a] px-5 py-8 text-center">
              <Fingerprint size={25} className="mx-auto text-gold/70" /><p className="mt-3 text-sm text-[#d9d3c5]">No wallet connected</p><p className="mt-1 text-xs text-[#77756e]">Create or restore a wallet. No registration required.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2"><button onClick={beginCreateWallet} className="gold-button rounded-lg px-4 py-2.5 text-xs font-semibold">Generate New Anonymous Wallet</button><button onClick={() => setModal('import')} className="quiet-button rounded-lg px-4 py-2.5 text-xs">Import Private Key</button></div>
            </div>}
          </div>

          <div className="glass-card rounded-2xl p-5 sm:p-6">
            <SectionTitle icon={Pickaxe} title="Proof-of-Work Miner" detail="SHA-256 · work runs in a dedicated browser worker" action={<span className={`rounded-full px-2.5 py-1 text-[9px] uppercase tracking-[.1em] ${minerOn ? 'bg-emerald-400/10 text-emerald-400' : 'bg-white/5 text-[#858279]'}`}>{minerOn ? 'Mining' : 'Standby'}</span>} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Hash rate" value={`${hashRate.toLocaleString()} H/s`} icon={Cpu} />
              <Metric label="Nonce tested" value={minerNonce.toLocaleString()} icon={Gauge} />
              <Metric label="Blocks mined" value={(state?.minedBlocks || 0).toLocaleString()} icon={Blocks} />
              <Metric label="Target" value={`${state?.difficulty ?? '—'} zeroes`} icon={Sparkles} />
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button disabled={!wallet} onClick={() => setMinerOn(value => !value)} className={`${minerOn ? 'quiet-button' : 'gold-button'} flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40`}>{minerOn ? <><X size={14} /> Stop Mining</> : <><Cpu size={14} /> Start Mining</>}</button>
              {!wallet && <span className="text-[10px] text-[#77756e]">Connect a wallet to receive rewards.</span>}
            </div>
            <div className="mt-4 rounded-xl border border-white/[.06] bg-black/20 p-3">
              <p className="mb-2 text-[9px] uppercase tracking-[.15em] text-[#77756e]">Miner activity</p>
              <div className="scrollbar max-h-24 space-y-1 overflow-auto">{activity.map((line, index) => <p key={`${index}-${line}`} className="mono flex gap-2 text-[10px] leading-5 text-[#aaa69b]"><span className="text-gold/70">›</span>{line}</p>)}</div>
            </div>
            <p className="mt-3 text-[10px] leading-5 text-[#6f6c63]">Difficulty adjusts every 10 blocks against recent timestamps. Keep this tab open while mining.</p>
          </div>

          <div className="glass-card rounded-2xl p-5 sm:p-6">
            <SectionTitle icon={Link2} title="Peer Network" detail="Connect another BNKR node by its HTTP origin" />
            <form onSubmit={addPeer} className="flex gap-2">
              <input className="field min-w-0 flex-1 rounded-lg px-3 py-2.5 text-xs" placeholder="http://127.0.0.1:4175" value={peerUrl} onChange={event => setPeerUrl(event.target.value)} required />
              <button className="quiet-button inline-flex items-center gap-2 rounded-lg px-3 text-xs"><Plus size={14} /> Add peer</button>
            </form>
            {state?.peers?.length > 0 && <div className="mt-3 space-y-2">{state.peers.map(peer => <div key={peer.url} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/[.025] px-3 py-2 text-[10px]"><span className="mono text-[#c9c4b8]">{peer.url}</span><span className={peer.lastError ? 'text-red-400' : 'text-emerald-400'}>{peer.lastError || (peer.lastSeen ? 'Connected' : 'Pending')}</span></div>)}</div>}
            <p className="mt-3 text-[10px] leading-5 text-[#6f6c63]">Peer nodes exchange signed transactions and validate shared blocks. Configure additional node URLs with BANNEKER_PEERS (or BLACKCOIN_PEERS for backward compatibility) to sync on startup.</p>
          </div>
        </section>

        <section className="space-y-5">
          <div className="glass-card rounded-2xl p-5 sm:p-6">
            <SectionTitle icon={Activity} title="Pending Mempool" detail={`${mempool.length} signed transaction${mempool.length === 1 ? '' : 's'} awaiting confirmation`} />
            {mempool.length ? <div className="scrollbar max-h-64 space-y-2 overflow-auto">{mempool.map((tx, index) => <div key={`${tx.sender}-${tx.nonce}`} className="rounded-xl border border-white/[.05] bg-black/20 p-3">
              <div className="flex items-center justify-between gap-3"><span className="mono text-[10px] text-[#aaa69b]">{short(tx.sender)}</span><span className="text-xs font-medium text-gold">{tx.amount} BNKR</span></div>
              <div className="mt-2 flex justify-between text-[9px] text-[#716e66]"><span>to {short(tx.recipient)}</span><span>nonce {tx.nonce} · {new Date(tx.timestamp).toLocaleTimeString()}</span></div>
            </div>)}</div> : <EmptyState text="No unconfirmed transfers." />}
          </div>

          <div className="glass-card overflow-hidden rounded-2xl">
            <div className="p-5 pb-3 sm:p-6 sm:pb-3">
              <SectionTitle icon={Blocks} title="Block Explorer" detail={`${totalBlocks.toLocaleString()} blocks · newest first`} action={latest && <span className="mono text-[9px] text-[#77756e]">TIP {short(latest.hash, 7, 5)}</span>} />
              <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#68665f]" /><input className="field rounded-lg py-2.5 pl-9 pr-3 text-xs" placeholder="Search block height, miner, or hash" value={search} onChange={event => {
                const next = event.target.value;
                setSearch(next);
                window.clearTimeout(searchTimer.current);
                searchTimer.current = window.setTimeout(() => void loadBlocks(0, next), 260);
              }} /></div>
            </div>
            <div className="scrollbar overflow-x-auto">
              <table className="w-full min-w-[690px] border-collapse text-left">
                <thead><tr className="border-y border-white/[.06] bg-white/[.02] text-[9px] uppercase tracking-[.12em] text-[#77756e]"><th className="px-4 py-3 font-medium">Block</th><th className="px-4 py-3 font-medium">Time</th><th className="px-4 py-3 font-medium">Miner</th><th className="px-4 py-3 font-medium">Tx</th><th className="px-4 py-3 font-medium">Nonce</th><th className="px-4 py-3 font-medium">Hash</th></tr></thead>
                <tbody>{blocks.map(block => <BlockRow key={block.height} block={block} expanded={expanded === block.height} onExpand={() => setExpanded(expanded === block.height ? null : block.height)} />)}
                  {!blocks.length && <tr><td colSpan="6"><EmptyState text={search ? 'No blocks match this search.' : 'The chain is initializing.'} /></td></tr>}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-white/[.06] px-4 py-3">
              <span className="text-[10px] text-[#77756e]">Page {page + 1} of {pageCount}</span>
              <div className="flex gap-2"><button aria-label="Previous page" disabled={page === 0} onClick={() => void loadBlocks(page - 1)} className="quiet-button rounded-lg p-2 disabled:opacity-30"><ArrowLeft size={13} /></button><button aria-label="Next page" disabled={(page + 1) * 25 >= totalBlocks} onClick={() => void loadBlocks(page + 1)} className="quiet-button rounded-lg p-2 disabled:opacity-30"><ArrowRight size={13} /></button></div>
            </div>
          </div>
        </section>
      </div>
      <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-white/[.06] pt-5 text-[10px] text-[#69675f]">
        <p>THE BANNEKER COIN <span className="text-gold">·</span> BNKR <span className="px-1">·</span> Created by The Handsome Devil</p>
        <p className="mono">Genesis · Nov 2026 · Open node software</p>
      </footer>
    </main>

    {notice && <div role="status" className={`fixed bottom-5 right-5 z-[60] flex max-w-[min(90vw,480px)] items-start gap-3 rounded-xl border px-4 py-3 text-xs shadow-2xl ${notice.kind === 'error' ? 'border-red-400/30 bg-[#211111] text-red-200' : 'border-gold/30 bg-[#19160c] text-[#e9dfc2]'}`}><span className="mt-0.5">{notice.kind === 'error' ? <CircleAlert size={15} /> : <Check size={15} />}</span>{notice.message}</div>}
    {modal === 'whitepaper' && <Whitepaper onClose={() => setModal(null)} />}
    {modal === 'wallet' && <Modal title="Create an anonymous wallet" onClose={() => setModal(null)}><p className="text-sm leading-7 text-[#b8b2a5]">A new Ed25519 keypair is generated in this browser and encrypted with a password you choose. The raw secret key is never stored; only the encrypted vault stays in this browser. Keep an offline backup of the vault and remember the password — neither can be recovered by a central authority.</p><div className="mt-5 flex flex-wrap justify-end gap-2"><button onClick={() => setModal('import')} className="quiet-button rounded-lg px-4 py-2.5 text-xs">Import existing key</button><button onClick={beginCreateWallet} className="gold-button rounded-lg px-4 py-2.5 text-xs font-semibold">Generate New Anonymous Wallet</button></div></Modal>}
    {modal === 'import' && <KeyModal title="Import private key" action="Continue" onClose={() => setModal(null)} onSubmit={beginImportWallet} />}
    {modal === 'password' && pendingWallet && <PasswordModal
      title="Protect your wallet"
      action={pendingWallet.mode === 'import' ? 'Encrypt & restore wallet' : 'Create encrypted wallet'}
      description="Choose a password of at least 12 characters. It encrypts the secret key in this browser with PBKDF2-SHA-256 and AES-GCM. The key cannot be recovered without it."
      onClose={() => { setPendingWallet(null); setModal(null); }}
      onSubmit={protectPendingWallet}
    />}
    {modal === 'migrate' && needsMigration && <PasswordModal
      title="Secure an existing wallet"
      action="Encrypt & remove plaintext"
      description="An unencrypted wallet was found in this browser. Set a password now: the key is moved into the encrypted vault and the plaintext entry is deleted."
      onClose={() => setModal(null)}
      onSubmit={protectLegacyWallet}
    />}
    {modal === 'sign' && signRequest && <PasswordModal
      title="Unlock to sign"
      action="Sign & broadcast"
      confirm={false}
      description="Enter your wallet password to decrypt the key for this transfer. The decrypted key is used only for this signature and is wiped from memory immediately."
      onClose={() => { setSignRequest(null); setModal(null); }}
      onSubmit={confirmSign}
    />}
    {modal === 'export' && wallet && <ExportModal wallet={wallet} vault={vault} onClose={() => setModal(null)} onCopy={copy} onDownload={downloadBackup} />}
    {modal === 'keys' && wallet && <Modal title="Wallet key management" onClose={() => setModal(null)}><div className="space-y-3"><div className="rounded-xl border border-white/[.06] bg-black/20 p-4"><p className="text-[9px] uppercase tracking-[.15em] text-[#77756e]">Public address</p><p className="mono mt-2 break-all text-xs leading-5 text-[#d6d0c3]">{wallet.publicKey}</p></div><div className="flex flex-wrap gap-2"><button onClick={() => setModal('export')} className="gold-button inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold"><ArrowDownToLine size={14} /> Export / Copy Private Key</button><button onClick={() => setModal('import')} className="quiet-button inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs"><KeyRound size={14} /> Import another key</button></div><p className="text-[10px] leading-5 text-amber-200/70">Never share your secret key. This software has not been independently audited.</p></div></Modal>}
  </div>;
}

function Telemetry({ label, value, detail, icon: Icon, wide = false }) {
  return <div className={`glass-card rounded-xl p-4 ${wide ? 'col-span-2 sm:col-span-1 lg:col-span-2' : ''}`}>
    <div className="flex items-center justify-between"><p className="text-[9px] uppercase tracking-[.15em] text-[#77756e]">{label}</p><Icon size={14} className="text-gold/75" /></div>
    <p className="mono mt-3 truncate text-base font-medium text-[#ede5d1]">{value}</p><p className="mt-1 text-[9px] text-[#6f6c63]">{detail}</p>
  </div>;
}

function Metric({ label, value, icon: Icon }) {
  return <div className="rounded-xl border border-white/[.06] bg-black/20 px-3 py-3"><div className="flex items-center justify-between"><span className="text-[9px] uppercase tracking-[.11em] text-[#77756e]">{label}</span><Icon size={12} className="text-gold/70" /></div><p className="mono mt-2 truncate text-xs text-[#e3dccb]">{value}</p></div>;
}

function EmptyState({ text }) {
  return <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-[#77756e]"><HardDrive size={14} />{text}</div>;
}

function BlockRow({ block, expanded, onExpand }) {
  return <>
    <tr className="border-b border-white/[.04] text-[10px] hover:bg-white/[.02]">
      <td className="px-4 py-3"><span className="mono text-gold">{block.height.toLocaleString()}</span></td>
      <td className="px-4 py-3 text-[#a49f91]">{new Date(block.timestamp).toLocaleString()}</td>
      <td className="px-4 py-3"><span className="mono text-[#b8b1a1]">{block.miner ? short(block.miner, 7, 5) : 'GENESIS'}</span></td>
      <td className="px-4 py-3 text-[#b8b1a1]">{block.transactions.length}</td>
      <td className="px-4 py-3 mono text-[#a49f91]">{block.nonce.toLocaleString()}</td>
      <td className="px-4 py-3"><button onClick={onExpand} title={block.hash} className="mono inline-flex items-center gap-1.5 text-left text-[#c9b876] hover:text-gold">{short(block.hash, 9, 5)}{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button></td>
    </tr>
    {expanded && <tr className="border-b border-white/[.06] bg-black/20"><td colSpan="6" className="p-3 sm:p-4"><pre className="scrollbar max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-white/[.05] bg-black/30 p-3 text-[9px] leading-5 text-[#b8b2a5]">{JSON.stringify(block, null, 2)}</pre></td></tr>}
  </>;
}

function KeyModal({ title, action, onClose, onSubmit }) {
  const [value, setValue] = useState('');
  return <Modal title={title} onClose={onClose}><p className="text-sm leading-6 text-[#aaa598]">Paste the base64-encoded 64-byte Ed25519 secret key. Key material is processed locally and never sent to the node.</p><textarea autoComplete="off" spellCheck="false" className="field mono mt-4 min-h-28 resize-y rounded-xl p-3 text-xs" placeholder="Base64 private key" value={value} onChange={event => setValue(event.target.value)} /><div className="mt-4 flex justify-end"><button disabled={!value.trim()} onClick={() => onSubmit(value)} className="gold-button rounded-lg px-4 py-2.5 text-xs font-semibold disabled:opacity-40">{action}</button></div></Modal>;
}

function PasswordModal({ title, action, description, onClose, onSubmit, confirm = true }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setError('');
    if (password.length < 12) {
      setError('Use a password with at least 12 characters.');
      return;
    }
    if (confirm && confirmation !== password) {
      setError('Passwords do not match.');
      return;
    }
    setWorking(true);
    try {
      await onSubmit(password);
      setPassword('');
      setConfirmation('');
      onClose();
    } catch (submitError) {
      setError(submitError.message || 'The wallet could not be protected.');
    } finally {
      setWorking(false);
    }
  };

  return <Modal title={title} onClose={onClose}>
    <p className="text-sm leading-7 text-[#b8b2a5]">{description}</p>
    <form onSubmit={submit} className="mt-5 space-y-4">
      <label className="block"><span className="mb-2 block text-[10px] uppercase tracking-[.12em] text-[#77756e]">Wallet password</span>
        <input type="password" autoComplete="new-password" className="field w-full rounded-lg px-3 py-3 text-xs" value={password} onChange={event => setPassword(event.target.value)} required autoFocus />
      </label>
      {confirm && <label className="block"><span className="mb-2 block text-[10px] uppercase tracking-[.12em] text-[#77756e]">Confirm password</span>
        <input type="password" autoComplete="new-password" className="field w-full rounded-lg px-3 py-3 text-xs" value={confirmation} onChange={event => setConfirmation(event.target.value)} required />
      </label>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="quiet-button rounded-lg px-4 py-2.5 text-xs">Cancel</button><button disabled={working} className="gold-button rounded-lg px-4 py-2.5 text-xs font-semibold disabled:opacity-40">{working ? 'Working…' : action}</button></div>
    </form>
  </Modal>;
}

function ExportModal({ wallet, vault, onClose, onCopy, onDownload }) {
  const [revealed, setRevealed] = useState(false);
  const [revealedSecretKey, setRevealedSecretKey] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const unlock = async event => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    try {
      const bytes = await decryptWallet(vault, password);
      const decoded = encodeBase64(bytes);
      setRevealedSecretKey(decoded);
      setRevealed(true);
    } catch (error) {
      alert(error.message);
    } finally {
      setBusy(false);
    }
  };

  const backup = () => {
    if (!vault) {
      alert('Set a wallet password first. Plaintext key export is disabled.');
      return;
    }
    onDownload(`bnkr-wallet-${wallet.publicKey.slice(0, 8)}.json`, vault);
  };

  return <Modal title="Back up your private key" onClose={onClose}>
    {!revealedSecretKey && vault ? (
      <form onSubmit={unlock} className="space-y-4">
        <div className="rounded-xl border border-gold/20 bg-gold/5 p-4">
          <p className="flex items-center gap-2 text-xs font-medium text-gold"><Lock size={14} /> Wallet is protected by a password</p>
          <p className="mt-2 text-[10px] leading-5 text-[#aaa598]">Enter your vault password to decrypt and reveal the private key.</p>
        </div>
        <input
          type="password"
          className="field rounded-lg px-3 py-3 text-xs"
          placeholder="Vault password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoFocus
          required
        />
        <button disabled={busy} className="gold-button w-full rounded-lg py-3 text-xs font-semibold">
          {busy ? 'Decrypting...' : 'Unlock & Reveal Key'}
        </button>
      </form>
    ) : (
      <>
        <div className="rounded-xl border border-amber-500/20 bg-amber-400/[.05] p-4">
          <p className="flex items-center gap-2 text-xs font-medium text-amber-200"><LockKeyhole size={14} /> Anyone with this key can spend this wallet’s funds.</p>
          <p className="mt-2 text-[10px] leading-5 text-[#aaa598]">Store it securely offline. Never paste it into a website you do not trust.</p>
        </div>
        <div className="mt-4 rounded-xl border border-white/[.06] bg-black/30 p-4">
          <p className="mono break-all text-xs leading-6 text-[#d8d1c2]">{revealed ? revealedSecretKey : '•'.repeat(52)}</p>
        </div>
        <div className="mt-4 flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            <button onClick={() => setRevealed(v => !v)} className="quiet-button rounded-lg px-4 py-2.5 text-xs">
              {revealed ? 'Hide key' : 'Reveal key'}
            </button>
            <button disabled={!revealed} onClick={() => onCopy(revealedSecretKey)} className="quiet-button inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs disabled:opacity-40">
              <Copy size={14} /> Copy Key
            </button>
          </div>
          <button onClick={backup} className="gold-button inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold">
            <Download size={14} /> Download Backup (JSON)
          </button>
        </div>
      </>
    )}
  </Modal>;
}

function Whitepaper({ onClose }) {
  return <Modal title="The Banneker Coin Manifesto" onClose={onClose}><div className="space-y-5 text-sm leading-7 text-[#bcb6a8]">
    <p className="font-display text-xl italic text-[#eee5d1]">"The Handsome Devil - Nov 2026 - No Central Mint, No Middlemen."</p>
    <div className="gold-rule h-px" />
    <p>The Banneker Coin (BNKR) is an open-source, peer-to-peer monetary protocol honoring Benjamin Banneker, the self-taught African American mathematician, astronomer, and clockmaker from Baltimore County, Maryland. Rooted in African American heritage and open to all, it pursues a simple goal: a public ledger, verifiable issuance, and transactions authorized by the holder of a private key - not an account at a central intermediary.</p>
    <h3 className="font-display text-xl text-gold">A fixed monetary schedule</h3>
    <p>New blocks begin with a 50 BNKR reward. The subsidy halves every 210,000 blocks, subject to a hard ceiling of 21,000,000 BNKR. Genesis creates no spendable coins. The initial reward schedule and the chain's proof-of-work are checked by every node.</p>
    <h3 className="font-display text-xl text-gold">Proof of work and shared history</h3>
    <p>Blocks commit to their parent, transactions, reward, miner, timestamp, and nonce using SHA-256. A block is accepted only when its hash meets the current leading-zero target. Every ten blocks, nodes adjust difficulty from observed timestamps toward a 15-second target interval.</p>
    <h3 className="font-display text-xl text-gold">Keys and transactions</h3>
    <p>Wallets use Ed25519 keypairs. A transfer binds the sender, recipient, amount, sequence number, and timestamp into a digital signature. Private keys remain in the browser in this implementation. Backups are the owner's responsibility; a lost or exposed key cannot be recovered by a central authority.</p>
    <h3 className="font-display text-xl text-gold">An invitation to verify</h3>
    <p>Anyone may inspect the code, run a node, and independently validate the chain. This implementation is an educational, early-stage network - not audited monetary infrastructure. Its consensus and peer discovery are intentionally simple and do not provide the economic security, Sybil resistance, or operational guarantees of a mature production network. Do not use it to store or transfer funds of value.</p>
    <p className="border-t border-white/[.07] pt-4 text-xs text-[#77756e]">The Handsome Devil · The Banneker Coin · BNKR</p>
  </div></Modal>;
}
