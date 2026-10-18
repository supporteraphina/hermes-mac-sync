/**
 * Agents tab: a SESSIONS | BOTS | AGENTS sidebar tab with every running chat and bot on the
 * backend, each with its helper agents drawn as a tree underneath. Click a row to open the chat.
 * Data: agents.py (embedded below, written to ~/.hermes/agents-tab/ on the backend) reads each
 * profile's state.db read only; session.active_list adds working / needs you for live chats.
 * Background agents (Codex, Claude Code, Grok, OpenCode, one-shot Hermes; any user, any launcher) show as
 * helpers under the chat that started them; one started outside a chat gets its own running row.
 * Click a helper: a Hermes helper opens as its own chat; a CLI agent opens a detail pane on the right
 * with the prompt the main agent gave it and its live output (agents.py detail <key>, polled).
 */
import { host, useQuery, useValue, atom } from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'agents-tab'
const PY_SRC = "\"\"\"Agents tab data: running chats per profile with their helper agents, read only from state.db.\"\"\"\nimport json, os, sqlite3, sys, time\nfrom pathlib import Path\n\nHOME = Path(os.environ.get(\"HERMES_HOME\") or Path.home() / \".hermes\")\nNOW = time.time()\nACTIVE = 150      # a chat counts as running if it did something in the last 150 s\nCHILD_LIVE = 900  # an unfinished helper counts as live if it did something in the last 15 min\nDONE_KEEP = 300   # finished helpers stay listed (ticked) for 5 min\n\n\ndef homes():\n    yield \"default\", HOME\n    pdir = HOME / \"profiles\"\n    if pdir.is_dir():\n        for p in sorted(pdir.iterdir()):\n            if (p / \"state.db\").exists():\n                yield p.name, p\n\n\ndef read(profile, home):\n    try:\n        db = sqlite3.connect(f\"file:{home / 'state.db'}?mode=ro\", uri=True, timeout=2)\n    except sqlite3.Error:\n        return []\n    db.row_factory = sqlite3.Row\n    since = NOW - CHILD_LIVE\n    try:\n        kids = db.execute(\n            \"select id, parent_session_id, title, ended_at, last_activity_at, started_at from sessions \"\n            \"where parent_session_id is not null and title like 'Subagent:%' \"\n            \"and coalesce(last_activity_at, started_at) > ?\", (since,)).fetchall()\n        recent = db.execute(\n            \"select id, title, source, last_activity_at, started_at from sessions \"\n            \"where coalesce(last_activity_at, started_at) > ? and coalesce(hidden,0)=0 and coalesce(archived,0)=0 \"\n            \"and (title is null or title not like 'Subagent:%') and source not in ('oneshot','subagent')\",\n            (NOW - ACTIVE,)).fetchall()\n        parents = {r[\"id\"]: dict(r) for r in recent}\n        need = {k[\"parent_session_id\"] for k in kids} - set(parents)\n        for pid in need:\n            r = db.execute(\"select id, title, source, last_activity_at, started_at from sessions where id=?\", (pid,)).fetchone()\n            if r:\n                parents[pid] = dict(r)\n    except sqlite3.Error:\n        return []\n    finally:\n        pass\n    out = []\n    for pid, p in parents.items():\n        helpers = []\n        for k in kids:\n            if k[\"parent_session_id\"] != pid:\n                continue\n            done = k[\"ended_at\"] is not None\n            if done and NOW - k[\"ended_at\"] > DONE_KEEP:\n                continue\n            title = (k[\"title\"] or \"Helper\").replace(\"Subagent:\", \"\", 1).strip().rstrip(\"…\").strip()\n            helpers.append({\"t\": title[:80], \"d\": done, \"s\": int(NOW - (k[\"started_at\"] or NOW)), \"k\": f\"s:{profile}:{k['id']}\"})\n        last = p.get(\"last_activity_at\") or p.get(\"started_at\") or 0\n        live = NOW - last < ACTIVE or any(not h[\"d\"] for h in helpers)\n        if not live:\n            continue\n        helpers.sort(key=lambda h: (h[\"d\"], -h[\"s\"]))\n        out.append({\"id\": pid, \"p\": profile, \"t\": (p.get(\"title\") or \"New chat\")[:80],\n                    \"src\": p.get(\"source\"), \"a\": int(NOW - last), \"h\": helpers[:8]})\n    db.close()\n    return out\n\n\nrows = []\nfor name, home in homes():\n    rows.extend(read(name, home))\nrows.sort(key=lambda r: r[\"a\"])\n\n\n# ---- background agents (Codex / Claude Code / Grok / OpenCode / one-shot Hermes), any user, any launcher ----\n# Drawn as helpers under the chat that started them. The chat comes from the agent-run sidecar\n# (<name>.meta.json) or the HERMES_SESSION_ID the process inherited from a chat's terminal.\n# `agents.py detail <key>` returns one helper's prompt and live output for the detail pane.\nimport re, subprocess\n\nAGENT_DIR = Path(\"/home/hermes/.hermes/cache/scratch/agents\")\nBG_DONE_KEEP = 1800\nCLI = [\n    (\"Codex\", re.compile(r\"(^|/)codex(\\.js)?\\s+(exec|e)\\b|codex-linux[^ ]*\\s+exec\\b\")),\n    (\"Claude\", re.compile(r\"(^|/)claude\\b.*\\s(-p|--print)\\b\")),\n    (\"Grok\", re.compile(r\"(^|/)grok\\b.*\\s(--prompt\\S*|-p)\\b\")),\n    (\"Hermes\", re.compile(r\"(^|/)hermes\\b.*\\schat\\b.*\\s(-q|--query\\S*)\\b\")),\n    (\"OpenCode\", re.compile(r\"(^|/)opencode\\b.*\\srun\\b\")),\n]\nWRAPPERS = (\"timeout \", \"/usr/bin/timeout \", \"bash \", \"/bin/bash \", \"/usr/bin/bash \", \"sh \", \"/bin/sh \", \"nohup \", \"setsid \")\nFILLER = re.compile(r\"^(you are|you're|your task is|task:|goal:|please|kristian'?s? words?:?)\\s+\", re.I)\n\n\ndef _read(path, limit=None, tail=False):\n    try:\n        with open(path, \"rb\") as f:\n            if tail and limit:\n                f.seek(0, 2)\n                f.seek(max(0, f.tell() - limit))\n            data = f.read(limit) if (limit and not tail) else f.read()\n        return data.decode(\"utf-8\", \"replace\")\n    except OSError:\n        return \"\"\n\n\ndef _title_from(prompt, fallback):\n    \"\"\"A short name from the first sentence of the prompt the main agent wrote.\"\"\"\n    for line in (prompt or \"\").splitlines():\n        s = line.strip().strip(\"#*-> \").strip()\n        if len(s) < 8 or s.startswith((\"```\", \"<\", \"{\", \"[\")):\n            continue\n        s = FILLER.sub(\"\", s)\n        s = re.split(r\"(?<=[.!?:;])\\s|\\s[-\\u2013\\u2014]\\s|\\(\", s)[0].rstrip(\".:;\")\n        words = s.split()\n        if len(words) > 7:\n            s = \" \".join(words[:7]) + \"\\u2026\"\n        return s[:1].upper() + s[1:]\n    return fallback\n\n\ndef _argv(pid):\n    try:\n        return [a.decode(\"utf-8\", \"replace\") for a in open(f\"/proc/{pid}/cmdline\", \"rb\").read().split(b\"\\0\") if a]\n    except OSError:\n        return []\n\n\ndef _prompt_of(kind, argv, cwd):\n    \"\"\"The prompt a CLI agent was started with: a prompt file argument, or the inline prompt text.\"\"\"\n    for i, a in enumerate(argv):\n        if a in (\"--prompt-file\", \"--query-file\") and i + 1 < len(argv):\n            f = Path(argv[i + 1])\n            return _read(f if f.is_absolute() else Path(cwd or \"/\") / f, 200000)\n    for i, a in enumerate(argv):\n        if a in (\"-p\", \"--print\", \"--prompt\", \"-q\", \"--query\") and i + 1 < len(argv) and not argv[i + 1].startswith(\"-\"):\n            return argv[i + 1]\n    longest = max((a for a in argv[1:] if not a.startswith(\"-\")), key=len, default=\"\")\n    return longest if len(longest) > 40 else \"\"\n\n\ndef _output_of(pid):\n    \"\"\"Where a CLI agent writes its output: its stdout file, if that is a regular file.\"\"\"\n    try:\n        target = os.readlink(f\"/proc/{pid}/fd/1\")\n    except OSError:\n        return None\n    return target if target.startswith(\"/\") and os.path.isfile(target) else None\n\n\ndef _last_progress(text):\n    lines = text.splitlines()\n    for i in range(len(lines) - 1, 0, -1):\n        if lines[i - 1].strip() in (\"codex\", \"assistant\") and lines[i].strip():\n            return lines[i].strip()[:200]\n    for line in reversed(lines):\n        s = line.strip()\n        if s and not s.startswith((\"exit \", \"tokens used\", \"exec\", \"succeeded in\", \"{\", \"}\")) and not s.replace(\",\", \"\").isdigit():\n            return s[:200]\n    return \"\"\n\n\ndef _meta(name):\n    try:\n        return json.loads((AGENT_DIR / f\"{name}.meta.json\").read_text())\n    except (OSError, ValueError):\n        return {}\n\n\ndef _unit_prompt(name):\n    \"\"\"agent-run writes '<name>.sh' with the prompt file it was given.\"\"\"\n    sh = _read(AGENT_DIR / f\"{name}.sh\")\n    m = re.search(r\"cat '([^']+)'|--prompt-file '([^']+)'\", sh)\n    path = (m.group(1) or m.group(2)) if m else None\n    return (_read(path, 200000) if path else \"\"), path\n\n\ndef _unit_of(pid):\n    try:\n        for line in open(f\"/proc/{pid}/cgroup\"):\n            m = re.search(r\"/agent-([^/]+)\\.service\", line)\n            if m:\n                return m.group(1)\n    except OSError:\n        pass\n    return None\n\n\ndef _session_of(pid, parents):\n    for _ in range(12):\n        try:\n            env = open(f\"/proc/{pid}/environ\", \"rb\").read().split(b\"\\0\")\n            for kv in env:\n                if kv.startswith(b\"HERMES_SESSION_ID=\"):\n                    v = kv.split(b\"=\", 1)[1].decode()\n                    prof = next((x.split(b\"=\", 1)[1].decode() for x in env if x.startswith(b\"HERMES_SESSION_PROFILE=\")), \"\")\n                    return v, prof or \"default\"\n        except OSError:\n            pass\n        pid = parents.get(pid)\n        if not pid or pid <= 1:\n            break\n    return None, None\n\n\ndef _nice(name):\n    return name.replace(\"-\", \" \").replace(\"_\", \" \").strip().capitalize()\n\n\ndef _cwd(pid):\n    try:\n        return os.readlink(f\"/proc/{pid}/cwd\")\n    except OSError:\n        return None\n\n\ndef background():\n    try:\n        ps = subprocess.run([\"ps\", \"-eo\", \"pid=,ppid=,etimes=,user=,args=\"], capture_output=True, text=True, timeout=5).stdout\n    except Exception:\n        ps = \"\"\n    parents, procs = {}, []\n    for line in ps.splitlines():\n        parts = line.split(None, 4)\n        if len(parts) < 5:\n            continue\n        pid, ppid, et, user, args = parts\n        parents[int(pid)] = int(ppid)\n        if args.startswith(WRAPPERS):\n            continue\n        for kind, rx in CLI:\n            if rx.search(args):\n                procs.append((int(pid), int(ppid), int(et), user, kind))\n                break\n    mine = {p[0] for p in procs}\n    out, seen = [], set()\n    for pid, ppid, et, user, kind in procs:\n        if ppid in mine or parents.get(ppid) in mine:\n            continue\n        unit = _unit_of(pid)\n        if unit:\n            seen.add(unit)\n            meta = _meta(unit)\n            prompt, _ = _unit_prompt(unit)\n            sid, prof = (meta.get(\"session\"), meta.get(\"profile\") or \"default\") if meta.get(\"session\") else _session_of(pid, parents)\n            title = meta.get(\"title\") or _title_from(prompt, _nice(unit))\n            progress = _last_progress(_read(AGENT_DIR / f\"{unit}.log\", 20000, tail=True))\n            key = f\"u:{unit}\"\n        else:\n            argv = _argv(pid)\n            prompt = _prompt_of(kind, argv, _cwd(pid))\n            sid, prof = _session_of(pid, parents)\n            title = _title_from(prompt, f\"{kind} agent\")\n            outp = _output_of(pid)\n            progress = _last_progress(_read(outp, 20000, tail=True)) if outp else \"\"\n            key = f\"p:{pid}\"\n        out.append({\"t\": title[:80], \"d\": False, \"s\": et, \"x\": progress, \"k\": key, \"kind\": kind,\n                    \"sid\": sid, \"sp\": prof})\n    if AGENT_DIR.is_dir():\n        for log in AGENT_DIR.glob(\"*.log\"):\n            name = log.stem\n            if name in seen:\n                continue\n            try:\n                age = NOW - log.stat().st_mtime\n                if age > BG_DONE_KEEP:\n                    continue\n            except OSError:\n                continue\n            text = _read(log, 20000, tail=True)\n            tail = text.strip().splitlines()\n            if not tail or not tail[-1].startswith(\"exit \"):\n                continue\n            meta = _meta(name)\n            prompt, _ = _unit_prompt(name)\n            out.append({\"t\": (meta.get(\"title\") or _title_from(prompt, _nice(name)))[:80], \"d\": True, \"s\": int(age),\n                        \"x\": _last_progress(text), \"k\": f\"u:{name}\", \"kind\": \"Codex\" if \"codex\" in _read(AGENT_DIR / f\"{name}.sh\") else \"Grok\",\n                        \"sid\": meta.get(\"session\"), \"sp\": meta.get(\"profile\") or \"default\"})\n    return out\n\n\ndef _session_row(profile, sid):\n    home = HOME if profile == \"default\" else HOME / \"profiles\" / profile\n    try:\n        db = sqlite3.connect(f\"file:{home / 'state.db'}?mode=ro\", uri=True, timeout=2)\n        r = db.execute(\"select title, source, last_activity_at, started_at from sessions where id=?\", (sid,)).fetchone()\n        db.close()\n    except sqlite3.Error:\n        return None\n    if not r:\n        return None\n    last = r[2] or r[3] or NOW\n    return {\"id\": sid, \"p\": profile, \"t\": (r[0] or \"New chat\")[:80], \"src\": r[1], \"a\": int(NOW - last), \"h\": []}\n\n\n\ndef _shorten_cmd(cmd):\n    c = cmd.strip()\n    c = re.sub(r\"\\s+in\\s+/\\S*$\", \"\", c)\n    m = re.match(r\"^/bin/(?:ba)?sh\\s+-lc\\s+(['\\\"])(.*)$\", c, re.S)\n    if m:\n        c = m.group(2)\n        if c.endswith(m.group(1)):\n            c = c[:-1]\n    c = re.sub(r\"<<\\s*\\\\?['\\\"]?(\\w+)['\\\"]?.*$\", lambda mm: f\"<<{mm.group(1)} \\u2026\", c)\n    c = re.sub(r\"\\s+\", \" \", c).strip()\n    return c[:300]\n\n\ndef timeline(text):\n    \"\"\"Turn a Codex exec log into events: what the agent said, commands it ran (with result), searches.\"\"\"\n    lines = text.splitlines()\n    ev, i, n = [], 0, len(lines)\n    heads = (\"codex\", \"exec\", \"user\", \"web search\", \"tokens used\", \"thinking\")\n    while i < n:\n        h = lines[i].strip()\n        if h == \"codex\":\n            j, buf = i + 1, []\n            while j < n and lines[j].strip() not in heads:\n                buf.append(lines[j]); j += 1\n            msg = \"\\n\".join(buf).strip()\n            if msg:\n                ev.append({\"k\": \"say\", \"t\": msg[:4000]})\n            i = j\n        elif h == \"exec\":\n            cmd = lines[i + 1] if i + 1 < n else \"\"\n            j, status, ms, out = i + 2, None, None, []\n            while j < n and lines[j].strip() not in heads:\n                m = re.match(r\"^\\s*(succeeded|exited (-?\\d+)) in (\\d+)ms:\", lines[j])\n                if m and status is None:\n                    status = \"ok\" if m.group(1) == \"succeeded\" else f\"exit {m.group(2)}\"\n                    ms = int(m.group(3))\n                elif status is not None:\n                    out.append(lines[j])\n                j += 1\n            ev.append({\"k\": \"run\", \"c\": _shorten_cmd(cmd), \"s\": status or (\"running\" if j >= n else \"ok\"), \"ms\": ms,\n                       \"o\": \"\\n\".join(out).strip()[-3000:]})\n            i = j\n        elif h == \"web search\":\n            q = lines[i + 1].strip() if i + 1 < n else \"\"\n            ev.append({\"k\": \"search\", \"t\": q[:300]})\n            i += 2\n        elif h == \"user\":\n            j = i + 1\n            while j < n and lines[j].strip() not in heads:\n                j += 1\n            i = j\n        else:\n            i += 1\n    return ev\n\n\nimport base64, gzip, hashlib\nPAGE_DIR = Path(os.environ.get(\"HOME\", \"/tmp\")) / \".hermes\" / \"agents-tab\" / \"pages\"\nPART = 3000\n\n\ndef emit(obj):\n    \"\"\"Print small JSON directly; anything larger is gzipped and served in parts (shell.exec keeps 4000 chars).\"\"\"\n    text = json.dumps(obj, separators=(\",\", \":\"))\n    if len(text) < 3500:\n        print(text)\n        return\n    blob = base64.b64encode(gzip.compress(text.encode(\"utf-8\"), 9)).decode()\n    key = hashlib.sha256(blob.encode()).hexdigest()[:16]\n    PAGE_DIR.mkdir(parents=True, exist_ok=True)\n    for old in PAGE_DIR.glob(\"*.b64\"):\n        try:\n            if NOW - old.stat().st_mtime > 600:\n                old.unlink()\n        except OSError:\n            pass\n    (PAGE_DIR / f\"{key}.b64\").write_text(blob)\n    print(json.dumps({\"paged\": key, \"chunks\": (len(blob) + PART - 1) // PART}))\n\n\nif len(sys.argv) > 3 and sys.argv[1] == \"part\":\n    key, i = sys.argv[2], int(sys.argv[3])\n    if not re.fullmatch(r\"[0-9a-f]{16}\", key):\n        sys.exit(2)\n    print((PAGE_DIR / f\"{key}.b64\").read_text()[i * PART:(i + 1) * PART])\n    sys.exit(0)\n\ndef detail(key):\n    \"\"\"Prompt and live output of one helper for the detail pane.\"\"\"\n    kind, _, ref = key.partition(\":\")\n    res = {\"key\": key, \"title\": \"\", \"kind\": \"\", \"prompt\": \"\", \"output\": \"\", \"running\": False, \"where\": \"\"}\n    if kind == \"u\":\n        name = ref\n        meta = _meta(name)\n        prompt, path = _unit_prompt(name)\n        log = AGENT_DIR / f\"{name}.log\"\n        out = _read(log, 400000, tail=True)\n        running = subprocess.run([\"systemctl\", \"--user\", \"is-active\", \"-q\", f\"agent-{name}\"]).returncode == 0\n        res.update(title=meta.get(\"title\") or _title_from(prompt, _nice(name)), prompt=prompt, output=out,\n                   running=running, where=str(log), kind=\"Codex\" if \"codex\" in _read(AGENT_DIR / f\"{name}.sh\") else \"Grok\")\n    elif kind == \"p\":\n        pid = int(ref)\n        argv = _argv(pid)\n        k = next((n for n, rx in CLI if rx.search(\" \".join(argv))), \"Agent\")\n        prompt = _prompt_of(k, argv, _cwd(pid))\n        outp = _output_of(pid)\n        res.update(title=_title_from(prompt, f\"{k} agent\"), kind=k, prompt=prompt or \" \".join(argv)[:4000],\n                   output=_read(outp, 60000, tail=True) if outp else \"(this agent writes to a terminal, not a file)\",\n                   running=bool(argv), where=outp or \"\")\n    ev = timeline(res[\"output\"]) if res[\"output\"] else []\n    if ev:\n        runs = [e for e in ev if e[\"k\"] == \"run\"]\n        res[\"stats\"] = {\"commands\": len(runs), \"failed\": sum(1 for e in runs if e[\"s\"] not in (\"ok\", \"running\")),\n                        \"messages\": sum(1 for e in ev if e[\"k\"] == \"say\")}\n        for e in ev:\n            if e.get(\"o\"):\n                e[\"o\"] = e[\"o\"][-1500:]\n        res[\"events\"] = ev[-120:]\n        res[\"output\"] = \"\"\n    else:\n        res[\"output\"] = res[\"output\"][-20000:]\n    res[\"prompt\"] = res[\"prompt\"][:30000]\n    emit(res)\n\n\nif len(sys.argv) > 2 and sys.argv[1] == \"detail\":\n    detail(sys.argv[2])\n    sys.exit(0)\n\ntry:\n    bg = background()\nexcept Exception:\n    bg = []\nindex = {(r[\"p\"], r[\"id\"]): r for r in rows}\nloose = []\nfor h in bg:\n    key = (h.pop(\"sp\") or \"default\", h.pop(\"sid\"))\n    if key[1]:\n        row = index.get(key) or _session_row(*key)\n        if row is not None:\n            if key not in index:\n                index[key] = row\n                rows.append(row)\n            row[\"h\"].append(h)\n            continue\n    loose.append(h)\nfor r in rows:\n    r[\"h\"].sort(key=lambda h: (h[\"d\"], -h[\"s\"]))\n    r[\"h\"] = r[\"h\"][:10]\nrows.sort(key=lambda r: (0 if any(not h[\"d\"] for h in r[\"h\"]) else 1, r[\"a\"]))\nrows = rows[:20]\nfor h in loose:\n    rows.append({\"id\": \"\", \"p\": \"default\", \"t\": h[\"t\"], \"src\": \"background\", \"a\": h[\"s\"], \"h\": [], \"bg\": True,\n                 \"d\": h[\"d\"], \"x\": h.get(\"x\", \"\"), \"k\": h[\"k\"]})\nemit(rows)\n"
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

// shell.exec keeps only the last 4000 characters of stdout, so agents.py pages larger answers:
// it prints {paged, chunks} and serves gzip+base64 slices with `agents.py part <key> <i>`.
async function gunzipBase64(b64) {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

async function runPy(args) {
  const out = await exec(`env -u PYTHONPATH /usr/bin/python3 ${DIR}/agents.py ${args}`)
  const head = JSON.parse(out.trim().split('\n').pop() || 'null')
  if (!head || Array.isArray(head) || !head.paged) return head
  if (!/^[0-9a-f]{16}$/.test(head.paged)) throw new Error('bad page key')
  const parts = new Array(head.chunks)
  for (let i = 0; i < head.chunks; i += 4) {
    const batch = []
    for (let j = i; j < Math.min(head.chunks, i + 4); j++) {
      batch.push(exec(`env -u PYTHONPATH /usr/bin/python3 ${DIR}/agents.py part ${head.paged} ${j}`).then(t => (parts[j] = t.trim())))
    }
    await Promise.all(batch)
  }
  return JSON.parse(await gunzipBase64(parts.join('')))
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
    runPy(''),
    host.request('session.active_list', {}).catch(() => null)
  ])
  const rows = Array.isArray(out) ? out : []
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

const DETAIL_KEY = `${ID}:detail`
const $detail = atom(null)
let closeDetail = null

async function loadDetail(key) {
  await ensureScript()
  return (await runPy(`detail '${String(key).replace(/'/g, '')}'`)) || {}
}

const C = {
  primary: 'var(--ui-text-primary, #fff)',
  secondary: 'var(--ui-text-secondary, #d4d4d4)',
  tertiary: 'var(--ui-text-tertiary, #9a9a9a)',
  quaternary: 'var(--ui-text-quaternary, #6f6f6f)',
  border: 'var(--ui-border, rgba(255,255,255,0.12))',
  hover: 'var(--ui-row-hover-background, rgba(255,255,255,0.05))',
  accent: 'var(--ui-accent, #6b8fd8)',
  green: 'var(--ui-green, #55a583)',
  red: 'var(--ui-red, #e75e78)',
  head: 'var(--theme-primary, #ddd)'
}
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const PRE = 'm-0'
const preStyle = { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: MONO, fontSize: 12, lineHeight: 1.45, color: C.tertiary }

function Block({ label, children, grow }) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, flex: grow ? 1 : 'none' },
    children: [
      jsx('div', { style: { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.head }, children: label }),
      children
    ]
  })
}

function Said({ text }) {
  return jsx('div', {
    style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.5, color: C.primary },
    children: text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\(<?[^)>]+>?\)/g, '$1')
  })
}

function Ran({ e }) {
  const [openOut, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const ok = e.s === 'ok'
  const running = e.s === 'running'
  const secs = e.ms != null ? (e.ms < 1000 ? `${e.ms}ms` : `${Math.round(e.ms / 1000)}s`) : ''
  return jsxs('div', {
    children: [
      jsxs('div', {
        onClick: () => e.o && setOpen(!openOut),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        title: e.o ? `${e.c}\n(click to see its output)` : e.c,
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px', borderRadius: 4, minWidth: 0,
                 cursor: e.o ? 'pointer' : 'default', background: hover && e.o ? C.hover : 'transparent' },
        children: [
          running
            ? jsx(Dot, { state: 'working' })
            : jsx('span', { style: { width: 14, flexShrink: 0, textAlign: 'center', fontSize: 11, color: ok ? C.green : C.red }, children: ok ? '✓' : '✗' }),
          jsx('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 11.5, color: C.tertiary }, children: e.c }),
          jsx('span', { style: { flexShrink: 0, fontSize: 11, color: ok || running ? C.quaternary : C.red }, children: running ? 'running' : ok ? secs : e.s })
        ]
      }),
      openOut ? jsx('pre', { style: { ...preStyle, marginLeft: 20, marginTop: 4, maxHeight: 260, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 4, padding: 8 }, children: e.o }) : null
    ]
  })
}

function Timeline({ events }) {
  return jsx('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 4 },
    children: events.map((e, i) =>
      e.k === 'say'
        ? jsx('div', { style: { margin: '6px 0', padding: '8px 10px', borderRadius: 6, background: C.hover }, children: jsx(Said, { text: e.t }) }, i)
        : e.k === 'search'
          ? jsx('div', { title: e.t, style: { padding: '2px 4px', fontSize: 11.5, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `searched the web: ${e.t}` }, i)
          : jsx(Ran, { e }, i)
    )
  })
}

function DetailPane() {
  const key = useValue($detail)
  const [full, setFull] = useState(false)
  const { data, error } = useQuery({
    queryKey: [ID, 'detail', key],
    queryFn: () => loadDetail(key),
    enabled: !!key,
    refetchInterval: q => (q?.state?.data?.running === false ? 15000 : 3000)
  })
  const note = text => jsx('div', { style: { padding: 16, fontSize: 13, color: C.tertiary }, children: text })
  if (!key) return note('Click a helper agent to see it here.')
  if (error) return note(String(error.message || error))
  if (!data) return note('Loading…')
  const d = data
  const st = d.stats
  const sub = [d.kind || 'Agent', d.running ? 'running' : 'finished', st ? `${st.commands} commands${st.failed ? `, ${st.failed} failed` : ''}` : null].filter(Boolean).join(' · ')
  const prompt = d.prompt || '(no task text found)'
  const long = prompt.length > 420
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 14, height: '100%', minHeight: 0, padding: 16, boxSizing: 'border-box' },
    children: [
      jsxs('div', {
        children: [
          jsx('div', { style: { fontSize: 15, fontWeight: 500, color: C.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: d.title || 'Helper agent' }),
          jsxs('div', { style: { marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.tertiary }, children: [jsx(Dot, { state: d.running ? 'working' : 'idle' }), sub] })
        ]
      }),
      jsx(Block, {
        label: 'Task from the main agent',
        children: jsxs('div', {
          style: { border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, maxHeight: full ? '45vh' : 'none', overflowY: 'auto' },
          children: [
            jsx('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.5, color: C.secondary }, children: full || !long ? prompt : prompt.slice(0, 420) + '…' }),
            long ? jsx('div', { onClick: () => setFull(!full), style: { marginTop: 6, fontSize: 12, color: C.accent, cursor: 'pointer' }, children: full ? 'Show less' : 'Show full task' }) : null
          ]
        })
      }),
      jsx(Block, {
        label: d.running ? 'What it is doing (live)' : 'What it did',
        grow: true,
        children: jsx('div', {
          style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse' },
          children: d.events ? jsx(Timeline, { events: d.events }) : jsx('pre', { style: preStyle, children: d.output || '(no output yet)' })
        })
      })
    ]
  })
}

function openHelper(h, row) {
  const k = h.k || ''
  crumb('helper', { k })
  if (k.startsWith('s:')) {
    const [, prof, sid] = k.split(':')
    Promise.resolve(host.openSession?.(sid, prof && prof !== 'default' ? { profile: prof } : {})).catch(err =>
      host.notify?.({ kind: 'error', message: `Could not open helper: ${err?.message || err}` })
    )
    return
  }
  if (!k) return
  $detail.set(k)
  if (closeDetail || typeof host.openWorkspace !== 'function') return
  closeDetail = host.openWorkspace(DETAIL_KEY, {
    title: 'Helper agent',
    minWidth: '24rem',
    dock: { pane: 'workspace', pos: 'right' },
    render: () => jsx(DetailPane, {}),
    onClose: () => {
      closeDetail = null
    }
  })
}

function open(row) {
  if (row.bg && row.k) return openHelper({ k: row.k }, row)
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
            className: `${ROW} ${h.k ? 'cursor-pointer hover:bg-(--ui-row-hover-background)' : ''}`,
            onClick: () => openHelper(h, row),
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
