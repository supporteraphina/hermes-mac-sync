/**
 * Agents tab: a SESSIONS | BOTS | AGENTS sidebar tab with every running chat and bot on the
 * backend, each with its helper agents drawn as a tree underneath. Click a row to open the chat.
 * Data: agents.py (embedded below, written to ~/.hermes/agents-tab/ on the backend) reads each
 * profile's state.db read only; session.active_list adds working / needs you for live chats.
 * Background agents (Codex, Claude Code, Grok, OpenCode, one-shot Hermes; any user, any launcher) show as
 * helpers under the chat that started them; one started outside a chat gets its own running row.
 */
import { host, useQuery, useValue, atom } from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

const ID = 'agents-tab'
const PY_SRC = "\"\"\"Agents tab data: running chats per profile with their helper agents, read only from state.db.\"\"\"\nimport json, os, sqlite3, sys, time\nfrom pathlib import Path\n\nHOME = Path(os.environ.get(\"HERMES_HOME\") or Path.home() / \".hermes\")\nNOW = time.time()\nACTIVE = 150      # a chat counts as running if it did something in the last 150 s\nCHILD_LIVE = 900  # an unfinished helper counts as live if it did something in the last 15 min\nDONE_KEEP = 300   # finished helpers stay listed (ticked) for 5 min\n\n\ndef homes():\n    yield \"default\", HOME\n    pdir = HOME / \"profiles\"\n    if pdir.is_dir():\n        for p in sorted(pdir.iterdir()):\n            if (p / \"state.db\").exists():\n                yield p.name, p\n\n\ndef read(profile, home):\n    try:\n        db = sqlite3.connect(f\"file:{home / 'state.db'}?mode=ro\", uri=True, timeout=2)\n    except sqlite3.Error:\n        return []\n    db.row_factory = sqlite3.Row\n    since = NOW - CHILD_LIVE\n    try:\n        kids = db.execute(\n            \"select id, parent_session_id, title, ended_at, last_activity_at, started_at from sessions \"\n            \"where parent_session_id is not null and title like 'Subagent:%' \"\n            \"and coalesce(last_activity_at, started_at) > ?\", (since,)).fetchall()\n        recent = db.execute(\n            \"select id, title, source, last_activity_at, started_at from sessions \"\n            \"where coalesce(last_activity_at, started_at) > ? and coalesce(hidden,0)=0 and coalesce(archived,0)=0 \"\n            \"and (title is null or title not like 'Subagent:%') and source not in ('oneshot','subagent')\",\n            (NOW - ACTIVE,)).fetchall()\n        parents = {r[\"id\"]: dict(r) for r in recent}\n        need = {k[\"parent_session_id\"] for k in kids} - set(parents)\n        for pid in need:\n            r = db.execute(\"select id, title, source, last_activity_at, started_at from sessions where id=?\", (pid,)).fetchone()\n            if r:\n                parents[pid] = dict(r)\n    except sqlite3.Error:\n        return []\n    finally:\n        pass\n    out = []\n    for pid, p in parents.items():\n        helpers = []\n        for k in kids:\n            if k[\"parent_session_id\"] != pid:\n                continue\n            done = k[\"ended_at\"] is not None\n            if done and NOW - k[\"ended_at\"] > DONE_KEEP:\n                continue\n            title = (k[\"title\"] or \"Helper\").replace(\"Subagent:\", \"\", 1).strip().rstrip(\"…\").strip()\n            helpers.append({\"t\": title[:80], \"d\": done, \"s\": int(NOW - (k[\"started_at\"] or NOW))})\n        last = p.get(\"last_activity_at\") or p.get(\"started_at\") or 0\n        live = NOW - last < ACTIVE or any(not h[\"d\"] for h in helpers)\n        if not live:\n            continue\n        helpers.sort(key=lambda h: (h[\"d\"], -h[\"s\"]))\n        out.append({\"id\": pid, \"p\": profile, \"t\": (p.get(\"title\") or \"New chat\")[:80],\n                    \"src\": p.get(\"source\"), \"a\": int(NOW - last), \"h\": helpers[:8]})\n    db.close()\n    return out\n\n\nrows = []\nfor name, home in homes():\n    rows.extend(read(name, home))\nrows.sort(key=lambda r: r[\"a\"])\n\n\n# ---- background agents (Codex / Claude Code / Grok / OpenCode / one-shot Hermes), any user, any launcher ----\n# Drawn as helpers under the chat that started them, like delegate_task helpers. The chat is known from the\n# agent-run sidecar (<name>.meta.json) or the HERMES_SESSION_ID the process inherited from a chat's terminal.\nimport re, subprocess\n\nAGENT_DIR = Path(\"/home/hermes/.hermes/cache/scratch/agents\")\nBG_DONE_KEEP = 300\nCLI = [\n    (\"codex\", re.compile(r\"(^|/)codex(\\.js)?\\s+(exec|e)\\b|codex-linux[^ ]*\\s+exec\\b\")),\n    (\"claude\", re.compile(r\"(^|/)claude\\b.*\\s(-p|--print)\\b\")),\n    (\"grok\", re.compile(r\"(^|/)grok\\b.*\\s(--prompt\\S*|-p)\\b\")),\n    (\"hermes\", re.compile(r\"(^|/)hermes\\b.*\\schat\\b.*\\s(-q|--query\\S*)\\b\")),\n    (\"opencode\", re.compile(r\"(^|/)opencode\\b.*\\srun\\b\")),\n]\nWRAPPERS = (\"timeout \", \"/usr/bin/timeout \", \"bash \", \"/bin/bash \", \"/usr/bin/bash \", \"sh \", \"/bin/sh \", \"nohup \", \"setsid \")\n\n\ndef _last_progress(log):\n    try:\n        with open(log, \"rb\") as f:\n            f.seek(0, 2)\n            f.seek(max(0, f.tell() - 20000))\n            lines = f.read().decode(\"utf-8\", \"replace\").splitlines()\n    except OSError:\n        return \"\"\n    for i in range(len(lines) - 1, 0, -1):\n        if lines[i - 1].strip() == \"codex\" and lines[i].strip():\n            return lines[i].strip()[:200]\n    return \"\"\n\n\ndef _meta(name):\n    try:\n        return json.loads((AGENT_DIR / f\"{name}.meta.json\").read_text())\n    except (OSError, ValueError):\n        return {}\n\n\ndef _unit_of(pid):\n    try:\n        for line in open(f\"/proc/{pid}/cgroup\"):\n            m = re.search(r\"/agent-([^/]+)\\.service\", line)\n            if m:\n                return m.group(1)\n    except OSError:\n        pass\n    return None\n\n\ndef _session_of(pid, parents):\n    \"\"\"HERMES_SESSION_ID inherited from the chat whose terminal started it (walks up the process tree).\"\"\"\n    for _ in range(12):\n        try:\n            env = open(f\"/proc/{pid}/environ\", \"rb\").read().split(b\"\\0\")\n            for kv in env:\n                if kv.startswith(b\"HERMES_SESSION_ID=\"):\n                    v = kv.split(b\"=\", 1)[1].decode()\n                    prof = next((x.split(b\"=\", 1)[1].decode() for x in env if x.startswith(b\"HERMES_SESSION_PROFILE=\")), \"\")\n                    return v, prof or \"default\"\n        except OSError:\n            pass\n        pid = parents.get(pid)\n        if not pid or pid <= 1:\n            break\n    return None, None\n\n\ndef _nice(name):\n    return name.replace(\"-\", \" \").replace(\"_\", \" \").strip().capitalize()\n\n\ndef background():\n    try:\n        ps = subprocess.run([\"ps\", \"-eo\", \"pid=,ppid=,etimes=,user=,args=\"], capture_output=True, text=True, timeout=5).stdout\n    except Exception:\n        ps = \"\"\n    parents, procs = {}, []\n    for line in ps.splitlines():\n        parts = line.split(None, 4)\n        if len(parts) < 5:\n            continue\n        pid, ppid, et, user, args = parts\n        parents[int(pid)] = int(ppid)\n        if args.startswith(WRAPPERS):\n            continue\n        for kind, rx in CLI:\n            if rx.search(args):\n                procs.append((int(pid), int(ppid), int(et), user, kind))\n                break\n    mine = {p[0] for p in procs}\n    out, seen = [], set()\n    for pid, ppid, et, user, kind in procs:\n        if ppid in mine or parents.get(ppid) in mine:\n            continue  # the outer agent process already stands for this one\n        unit = _unit_of(pid)\n        meta = _meta(unit) if unit else {}\n        if unit:\n            seen.add(unit)\n        sid, prof = (meta.get(\"session\"), meta.get(\"profile\") or \"default\") if meta.get(\"session\") else _session_of(pid, parents)\n        title = meta.get(\"title\") or (_nice(unit) if unit else f\"{kind.capitalize()} agent\")\n        out.append({\"t\": title[:80], \"d\": False, \"s\": et, \"x\": _last_progress(AGENT_DIR / f\"{unit}.log\") if unit else \"\",\n                    \"sid\": sid, \"sp\": prof})\n    if AGENT_DIR.is_dir():\n        for log in AGENT_DIR.glob(\"*.log\"):\n            name = log.stem\n            if name in seen:\n                continue\n            try:\n                age = NOW - log.stat().st_mtime\n                if age > BG_DONE_KEEP:\n                    continue\n                tail = log.read_bytes()[-400:].decode(\"utf-8\", \"replace\").strip().splitlines()\n            except OSError:\n                continue\n            if not tail or not tail[-1].startswith(\"exit \"):\n                continue\n            meta = _meta(name)\n            out.append({\"t\": (meta.get(\"title\") or _nice(name))[:80], \"d\": True, \"s\": int(age), \"x\": _last_progress(log),\n                        \"sid\": meta.get(\"session\"), \"sp\": meta.get(\"profile\") or \"default\"})\n    return out\n\n\ndef _session_row(profile, sid):\n    home = HOME if profile == \"default\" else HOME / \"profiles\" / profile\n    try:\n        db = sqlite3.connect(f\"file:{home / 'state.db'}?mode=ro\", uri=True, timeout=2)\n        r = db.execute(\"select title, source, last_activity_at, started_at from sessions where id=?\", (sid,)).fetchone()\n        db.close()\n    except sqlite3.Error:\n        return None\n    if not r:\n        return None\n    last = r[2] or r[3] or NOW\n    return {\"id\": sid, \"p\": profile, \"t\": (r[0] or \"New chat\")[:80], \"src\": r[1], \"a\": int(NOW - last), \"h\": []}\n\n\ntry:\n    bg = background()\nexcept Exception:\n    bg = []\nindex = {(r[\"p\"], r[\"id\"]): r for r in rows}\nloose = []\nfor h in bg:\n    key = (h.pop(\"sp\") or \"default\", h.pop(\"sid\"))\n    if key[1]:\n        row = index.get(key) or _session_row(*key)\n        if row is not None:\n            if key not in index:\n                index[key] = row\n                rows.append(row)\n            row[\"h\"].append(h)\n            continue\n    loose.append(h)\nfor r in rows:\n    r[\"h\"].sort(key=lambda h: (h[\"d\"], -h[\"s\"]))\n    r[\"h\"] = r[\"h\"][:10]\nrows.sort(key=lambda r: (0 if any(not h[\"d\"] for h in r[\"h\"]) else 1, r[\"a\"]))\nrows = rows[:20]\nfor h in loose:  # started outside any chat (cron, root, another machine user): its own running row\n    rows.append({\"id\": \"\", \"p\": \"default\", \"t\": h[\"t\"], \"src\": \"background\", \"a\": h[\"s\"], \"h\": [], \"bg\": True,\n                 \"d\": h[\"d\"], \"x\": h.get(\"x\", \"\")})\nprint(json.dumps(rows, separators=(\",\", \":\")))\n"
const DIR = '"$HOME/.hermes/agents-tab"'
const $none = atom(null)
const st = name => host.state?.[name] || $none

const b64 = text => btoa(unescape(encodeURIComponent(text)))
function hash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function exec(command) {
  const res = await host.request('shell.exec', { command })
  if (!res || res.code !== 0) throw new Error((res && (res.stderr || res.stdout)) || 'command failed')
  return res.stdout || ''
}

function crumb(event, detail = {}) {
  try {
    const line = b64(JSON.stringify({ t: new Date().toISOString(), event, ...detail }) + '\n')
    void host.request('shell.exec', { command: `echo ${line} | base64 -d >> "$HOME/.hermes/agents-tab.log"` }).catch(() => {})
  } catch {}
}

let ready = null
function ensureScript() {
  if (!ready) {
    const v = hash(PY_SRC)
    ready = exec(
      `mkdir -p ${DIR} && if [ "$(cat ${DIR}/.v 2>/dev/null)" != "${v}" ]; then ` +
        `echo ${b64(PY_SRC)} | base64 -d > ${DIR}/agents.py && echo ${v} > ${DIR}/.v; fi; echo ok`
    ).catch(err => {
      ready = null
      throw err
    })
  }
  return ready
}

async function load() {
  await ensureScript()
  const [out, live] = await Promise.all([
    exec(`env -u PYTHONPATH /usr/bin/python3 ${DIR}/agents.py`),
    host.request('session.active_list', {}).catch(() => null)
  ])
  const rows = JSON.parse(out.trim().split('\n').pop() || '[]')
  const byKey = {}
  for (const s of live?.sessions || []) byKey[s.session_key || s.id] = s
  return { rows, byKey }
}

const fmt = s => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`)

const ROW = 'flex min-h-[1.625rem] min-w-0 items-center gap-1.5 rounded-md pl-2 pr-2 py-0.5'
const LABEL = 'min-w-0 flex-1 truncate leading-[1.35] text-[0.8125rem]'
const AGE = 'shrink-0 text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)'
const LEAD = 'grid size-3.5 shrink-0 place-items-center'

function Section({ label }) {
  return jsx('div', {
    className: 'flex shrink-0 items-center gap-1 pb-1 pt-3',
    children: jsxs('span', {
      className: 'flex min-w-0 items-center gap-2 pl-2 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-(--theme-primary)',
      children: [
        jsx('span', { 'aria-hidden': 'true', className: 'dither inline-block size-2 shrink-0 rounded-[1px]' }),
        jsx('span', { className: 'min-w-0 truncate leading-none', children: label })
      ]
    })
  })
}

function Dot({ state }) {
  const cls =
    state === 'needs' ? 'bg-amber-500' : state === 'working' ? 'bg-(--ui-accent)' : 'border border-(--ui-text-tertiary)'
  return jsx('span', { className: LEAD, children: jsx('span', { className: `size-1.5 rounded-full ${cls}` }) })
}

function open(row) {
  if (row.bg || !row.id) return
  const opts = row.p && row.p !== 'default' ? { profile: row.p } : {}
  Promise.resolve(host.openSession?.(row.id, opts)).catch(err =>
    host.notify?.({ kind: 'error', message: `Could not open chat: ${err?.message || err}` })
  )
}

function Chat({ row, state, focused, bot }) {
  const title = bot ? `${row.p} · ${row.t}` : row.t
  const right = state === 'needs' ? jsx('span', { className: 'shrink-0 text-[0.6875rem] text-amber-500', children: 'needs you' }) : jsx('span', { className: AGE, children: state === 'working' ? 'now' : fmt(row.a) })
  const n = row.h.length
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: `${ROW} cursor-pointer hover:bg-(--ui-row-hover-background) ${focused ? 'bg-(--ui-row-active-background)' : ''}`,
        onClick: () => open(row),
        title: row.x ? `${title}\n${row.x}` : title,
        children: [jsx(Dot, { state }), jsx('span', { className: `${LABEL} text-(--ui-text-secondary)`, children: title }), right]
      }),
      ...row.h.map((h, i) =>
        jsxs(
          'div',
          {
            className: ROW,
            title: h.x ? `${h.t}\n${h.x}` : h.t,
            children: [
              jsx('span', {
                className: 'shrink-0 whitespace-pre pl-1 font-mono text-[0.75rem] leading-none text-(--ui-text-quaternary)',
                children: i === n - 1 ? '└─' : '├─'
              }),
              h.d
                ? jsx('span', { className: `${LEAD} text-[0.65rem] text-(--ui-green,#55a583)`, children: '✓' })
                : jsx(Dot, { state: 'working' }),
              jsx('span', { className: `${LABEL} text-(--ui-text-tertiary)`, children: h.t }),
              jsx('span', { className: AGE, children: h.d ? 'done' : fmt(h.s) })
            ]
          },
          i
        )
      )
    ]
  })
}

function AgentsTab() {
  const busy = useValue(st('busyBySession')) || {}
  const focusedStored = useValue(st('focusedStoredSessionId'))
  const anyBusy = Object.values(busy).some(Boolean)
  const { data, error } = useQuery({ queryKey: [ID], queryFn: load, refetchInterval: anyBusy ? 3000 : 6000 })
  const rows = data?.rows || []
  const byKey = data?.byKey || {}
  const stateOf = row => {
    if (row.bg) return row.d ? 'idle' : 'working'
    const live = row.p === 'default' ? byKey[row.id] : null
    if (live && String(live.status) === 'waiting') return 'needs'
    if ((live && (busy[live.id] || ['working', 'streaming', 'starting'].includes(String(live.status)))) || row.h.some(h => !h.d) || row.a < 20) return 'working'
    return 'idle'
  }
  const chats = rows.filter(r => r.p === 'default' || r.bg)
  const bots = rows.filter(r => r.p !== 'default' && !r.bg)
  const empty = text =>
    jsxs('div', { className: ROW, children: [jsx('span', { className: LEAD }), jsx('span', { className: `${LABEL} text-(--ui-text-quaternary)`, children: text })] })
  return jsxs('div', {
    className: 'h-full min-h-0 overflow-y-auto px-2 pb-3',
    children: [
      jsx(Section, { label: 'Running' }),
      error ? empty(String(error.message || error)) : chats.length ? chats.map((r, i) => jsx(Chat, { row: r, state: stateOf(r), focused: !!r.id && r.id === focusedStored }, r.id || `bg${i}`)) : empty('Nothing running'),
      jsx(Section, { label: 'Bots' }),
      bots.length ? bots.map(r => jsx(Chat, { row: r, state: stateOf(r), focused: r.id === focusedStored, bot: true }, `${r.p}:${r.id}`)) : empty('All bots idle')
    ]
  })
}

export default {
  id: ID,
  name: 'Agents tab',
  register(ctx) {
    crumb('loaded', { openWorkspace: typeof host.openWorkspace })
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Agents',
      data: {
        placement: 'left',
        width: '260px',
        collapsible: true,
        hideOnly: true,
        tabTitleText: () => 'Agents',
        dock: { pane: 'sessions', pos: 'center', enforce: true }
      },
      render: () => {
        crumb('render')
        return jsx(AgentsTab, {})
      }
    })
  }
}
