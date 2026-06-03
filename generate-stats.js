// GitHub GraphQL API から統計を取得し、cards/ に 3 枚の SVG カードを生成する。
//   cards/identity.svg ... プロフィール（名前 / bio / location / since / repos / followers / stars）
//   cards/year.svg     ... 過去1年のコントリビューション折れ線
//   cards/work.svg     ... 言語比率 / 時間帯別コミット時計 / STATS
// 依存パッケージなし（Node 18+ の組み込み fetch を使用）。
//
// 必要な環境変数:
//   GITHUB_TOKEN  ... GraphQL 用トークン（private も集計したいなら repo+read:user の Classic PAT）
//   GITHUB_USER   ... 対象ユーザー名（未指定なら "sato0825"）

const fs = require("fs");

const USER = process.env.GITHUB_USER || "sato0825";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("環境変数 GITHUB_TOKEN が設定されていません。");
  process.exit(1);
}

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    id
    name
    login
    bio
    location
    createdAt
    avatarUrl(size: 140)
    followers { totalCount }
    repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) {
      totalCount
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays { contributionCount date }
        }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 8, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 100, author: {id: $userId}) {
                nodes { committedDate }
              }
            }
          }
        }
      }
    }
  }
}
`;

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API エラー: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL エラー: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// アイコン画像を取得して data URI 化（GitHub は SVG 内の外部 URL を読まないため埋め込む）
async function fetchAvatarDataUri(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "stats-generator" } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "image/png";
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ---- ユーティリティ ----
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );

const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const kfmt = (n) => {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
  }
  return String(n);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const seasonOf = (m) =>
  m === 11 || m <= 1 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : "autumn";

// Catmull-Rom スプラインを cubic bezier のパス文字列に変換
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(
      1
    )},${p2.y.toFixed(1)}`;
  }
  return d;
}

// 全カード共通の defs（影フィルタ・カード背景グラデーション）
const DEFS = `
  <filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="7" flood-color="#E7B6D5" flood-opacity="0.28"/></filter>
  <linearGradient id="card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFBFD"/></linearGradient>`;

// README は SVG を <img> として埋め込むため、エントランスアニメーションに依存すると
// 静的レンダラで「隠れたまま」になり得る。常時フル表示の静止状態で完成させる。

// =================== identity ===================
function buildIdentity(d) {
  const repos = d.repos.totalCount;
  const bio = d.bio ? (d.bio.length > 42 ? d.bio.slice(0, 41) + "…" : d.bio) : "—";
  const stat = (x, val, label) =>
    `<text x="${x}" y="74" text-anchor="middle" font-size="26" font-weight="700" fill="#4A4060">${esc(
      val
    )}</text><text x="${x}" y="94" text-anchor="middle" font-size="11" letter-spacing="0.5" fill="#B7ABC6">${label}</text>`;

  // アイコンが取れていれば円形クリップで埋め込み、無ければ手描きの顔にフォールバック
  const avatar = d.avatar
    ? `<image href="${d.avatar}" x="30" y="40" width="68" height="68" clip-path="url(#avt)" preserveAspectRatio="xMidYMid slice"/><circle cx="64" cy="74" r="34" fill="none" stroke="#fff" stroke-width="3"/>`
    : `<circle cx="64" cy="74" r="34" fill="#F6DCEC" stroke="#fff" stroke-width="3"/>
  <circle cx="53" cy="71" r="3.2" fill="#8A6E86"/><circle cx="75" cy="71" r="3.2" fill="#8A6E86"/>
  <path d="M55,81 Q64,90 73,81" stroke="#8A6E86" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="148" viewBox="0 0 840 148"><defs>${DEFS}<clipPath id="avt"><circle cx="64" cy="74" r="34"/></clipPath></defs>
  <rect x="6" y="6" width="828" height="136" rx="26" fill="url(#card)" stroke="#EFE0EE" stroke-width="2" filter="url(#sh)"/>
  ${avatar}
  <text x="116" y="64" font-size="29" font-weight="700" fill="#4A4060">${esc(d.name || d.login)}</text>
  <text x="116" y="88" font-size="13.5" fill="#8B8197">@${esc(d.login)}<tspan dx="10" fill="#B7ABC6">•</tspan><tspan dx="10">${esc(
    bio
  )}</tspan></text>
  <text x="116" y="110" font-size="12.5" fill="#B7ABC6">⚑ ${esc(
    d.location || "—"
  )}<tspan dx="14">◷ on github since ${d.since}</tspan></text>
  <line x1="515" y1="44" x2="515" y2="104" stroke="#EFE6F0" stroke-width="1.5"/>
  ${stat(575, repos, "repositories")}${stat(670, kfmt(d.followers), "followers")}${stat(
    765,
    kfmt(d.totalContributions),
    "contributions"
  )}</svg>`;
}

// =================== year ===================
function buildYear(d) {
  // 週ごとの合計を点列に
  const weeks = d.weeks.map((w) => ({
    total: w.contributionDays.reduce((s, x) => s + x.contributionCount, 0),
    first: w.contributionDays[0] ? w.contributionDays[0].date : null,
  }));
  const n = weeks.length;
  const maxV = Math.max(1, ...weeks.map((w) => w.total));
  const x0 = 40,
    x1 = 806,
    yTop = 108,
    yBottom = 192;
  const pts = weeks.map((w, i) => ({
    x: x0 + (i / (n - 1)) * (x1 - x0),
    y: yBottom - (w.total / maxV) * (yBottom - yTop),
  }));
  const line = smoothPath(pts);
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},196 L${pts[0].x.toFixed(1)},196 Z`;

  // ピーク週
  let peakI = 0;
  weeks.forEach((w, i) => {
    if (w.total > weeks[peakI].total) peakI = i;
  });
  const peak = pts[peakI];
  const peakDate = weeks[peakI].first ? new Date(weeks[peakI].first) : null;
  const season = peakDate ? seasonOf(peakDate.getUTCMonth()) : "";
  const labelX = Math.max(70, Math.min(776, peak.x));

  // 月ラベル（7点）
  let months = "";
  for (let t = 0; t <= 6; t++) {
    const wi = Math.round((t / 6) * (n - 1));
    const dt = weeks[wi].first ? new Date(weeks[wi].first) : null;
    const lbl = dt ? MONTHS[dt.getUTCMonth()] : "";
    const x = x0 + (t / 6) * (x1 - x0);
    months += `<text x="${x.toFixed(0)}" y="214" text-anchor="middle" font-size="10" fill="#B7ABC6">${lbl}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="228" viewBox="0 0 840 228"><defs>${DEFS}
  <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E29BC2" stop-opacity="0.45"/><stop offset="1" stop-color="#E29BC2" stop-opacity="0.04"/></linearGradient></defs>
  <rect x="6" y="6" width="828" height="216" rx="26" fill="url(#card)" stroke="#EFE0EE" stroke-width="2" filter="url(#sh)"/>
  <text x="32" y="40" font-size="11" letter-spacing="2.5" font-weight="700" fill="#B7ABC6">THIS YEAR</text>
  <text x="32" y="84" font-size="40" font-weight="700" fill="#4A4060">${comma(d.totalContributions)}</text>
  <text x="32" y="104" font-size="12.5" fill="#B7ABC6">contributions in the last year</text>
  <line x1="40" y1="153" x2="806" y2="153" stroke="#EFE6F0" stroke-width="1" stroke-dasharray="2 4"/><line x1="40" y1="110" x2="806" y2="110" stroke="#EFE6F0" stroke-width="1" stroke-dasharray="2 4"/>
  <path d="${area}" fill="url(#ag)"/><path d="${line}" fill="none" stroke="#E29BC2" stroke-width="2.5" stroke-linejoin="round"/>
  <circle cx="${peak.x.toFixed(1)}" cy="${peak.y.toFixed(
    1
  )}" r="4" fill="#fff" stroke="#E29BC2" stroke-width="2.5"/><text x="${labelX.toFixed(
    1
  )}" y="${(peak.y - 12).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#5E5470">busiest · ${season}</text>
  ${months}</svg>`;
}

// =================== work ===================
function buildWork(d) {
  // --- 言語（上位4・表示分で正規化して 100%）---
  const top = d.topLangs.slice(0, 4);
  const sum = top.reduce((s, l) => s + l.size, 0) || 1;
  const langs = top.map((l) => ({ ...l, pct: Math.round((l.size / sum) * 100) }));
  const barX = 32,
    barW = 252;
  let acc = barX;
  let segs = "";
  langs.forEach((l, i) => {
    const w = (l.size / sum) * barW;
    segs += `<rect x="${acc.toFixed(1)}" y="82" width="${w.toFixed(1)}" height="16" fill="${l.color}"/>`;
    acc += w;
  });
  let legend = "";
  langs.forEach((l, i) => {
    const y = 120 + i * 26;
    legend += `<circle cx="37" cy="${y}" r="5" fill="${l.color}"/><text x="50" y="${
      y + 4
    }" font-size="13" fill="#5E5470">${esc(l.name)}</text><text x="284" y="${
      y + 4
    }" text-anchor="end" font-size="12.5" font-weight="700" fill="#8B8197">${l.pct}%</text>`;
  });

  // --- 時間帯別コミット時計 ---
  const cx = 440,
    cy = 152,
    rin = 24,
    maxLen = 60;
  const maxH = Math.max(1, ...d.hours);
  let rays = "";
  for (let h = 0; h < 24; h++) {
    const theta = (h / 24) * 2 * Math.PI;
    const sn = Math.sin(theta),
      cs = Math.cos(theta);
    const len = (d.hours[h] / maxH) * maxLen;
    const sx = cx + rin * sn,
      sy = cy - rin * cs;
    const ex = cx + (rin + len) * sn,
      ey = cy - (rin + len) * cs;
    rays += `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(
      1
    )}" stroke="#E29BC2" stroke-width="4.4" stroke-linecap="round"/>`;
  }
  let peakH = 0;
  for (let h = 0; h < 24; h++) if (d.hours[h] > d.hours[peakH]) peakH = h;
  const peakLabel = String(peakH).padStart(2, "0") + ":00";

  // --- STATS ---
  const rows = [
    ["commits", kfmt(d.commits)],
    ["pull requests", kfmt(d.prs)],
    ["issues", kfmt(d.issues)],
  ];
  let stats = "";
  rows.forEach(([k, v], i) => {
    const y = 110 + i * 44;
    stats += `<text x="600" y="${y}" font-size="13" fill="#8B8197">${k}</text><text x="808" y="${y}" text-anchor="end" font-size="15" font-weight="700" fill="#4A4060">${esc(
      v
    )}</text>`;
    if (i < rows.length - 1)
      stats += `<line x1="600" y1="${y + 12}" x2="808" y2="${y + 12}" stroke="#EFE6F0" stroke-width="1"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="256" viewBox="0 0 840 256"><defs>${DEFS}<clipPath id="bclip"><rect x="32" y="82" width="252" height="16" rx="8"/></clipPath></defs>
  <rect x="6" y="6" width="828" height="244" rx="26" fill="url(#card)" stroke="#EFE0EE" stroke-width="2" filter="url(#sh)"/>
  <text x="32" y="46" font-size="11" letter-spacing="2.5" font-weight="700" fill="#B7ABC6">LANGUAGES</text>
  <g clip-path="url(#bclip)"><rect x="32" y="82" width="252" height="16" fill="#F4ECF3"/>${segs}</g>
  ${legend}
  <line x1="312" y1="38" x2="312" y2="222" stroke="#EFE6F0" stroke-width="1.5"/>
  <text x="352" y="46" font-size="11" letter-spacing="2.5" font-weight="700" fill="#B7ABC6">WHEN I CODE</text>
  <circle cx="440" cy="152" r="84" fill="none" stroke="#EFE6F0" stroke-width="1"/>
  ${rays}
  <text x="440" y="59.5" text-anchor="middle" font-size="10" fill="#B7ABC6">0</text><text x="536" y="155.5" text-anchor="middle" font-size="10" fill="#B7ABC6">6</text><text x="440" y="251.5" text-anchor="middle" font-size="10" fill="#B7ABC6">12</text><text x="344" y="155.5" text-anchor="middle" font-size="10" fill="#B7ABC6">18</text>
  <text x="440" y="149" text-anchor="middle" font-size="9.5" letter-spacing="1" fill="#B7ABC6">PEAK</text><text x="440" y="165" text-anchor="middle" font-size="14" font-weight="700" fill="#4A4060">${peakLabel}</text>
  <line x1="568" y1="38" x2="568" y2="222" stroke="#EFE6F0" stroke-width="1.5"/>
  <text x="600" y="46" font-size="11" letter-spacing="2.5" font-weight="700" fill="#B7ABC6">STATS</text>
  ${stats}</svg>`;
}

// ---- 取得データの整形 ----
function summarize(user) {
  const c = user.contributionsCollection;
  const repos = user.repositories.nodes;

  const totalStars = repos.reduce((s, r) => s + r.stargazerCount, 0);

  // 言語をバイト数で集計
  const langBytes = {};
  for (const r of repos) {
    for (const e of r.languages.edges) {
      const name = e.node.name;
      if (!langBytes[name]) langBytes[name] = { name, size: 0, color: e.node.color || "#B7ABC6" };
      langBytes[name].size += e.size;
    }
  }
  const topLangs = Object.values(langBytes).sort((a, b) => b.size - a.size);

  // コミットの時間帯（committedDate のローカル時刻の hour を集計）
  const hours = new Array(24).fill(0);
  for (const r of repos) {
    const hist = r.defaultBranchRef && r.defaultBranchRef.target && r.defaultBranchRef.target.history;
    if (!hist) continue;
    for (const node of hist.nodes) {
      const m = /T(\d{2}):/.exec(node.committedDate); // ISO のローカル時（オフセット込み表記）の hour
      if (m) hours[parseInt(m[1], 10)]++;
    }
  }

  return {
    name: user.name,
    login: user.login,
    bio: user.bio,
    location: user.location,
    since: new Date(user.createdAt).getUTCFullYear(),
    followers: user.followers.totalCount,
    repos: user.repositories,
    totalStars,
    topLangs,
    hours,
    commits: c.totalCommitContributions,
    prs: c.totalPullRequestContributions,
    issues: c.totalIssueContributions,
    reviews: c.totalPullRequestReviewContributions,
    contributedTo: user.repositoriesContributedTo.totalCount,
    totalContributions: c.contributionCalendar.totalContributions,
    weeks: c.contributionCalendar.weeks,
  };
}

(async () => {
  try {
    // user id を author フィルタに使うため、$userId を埋め込んで実行
    const idData = await graphql(`query($login:String!){user(login:$login){id}}`, { login: USER });
    const userId = idData.user.id;
    const query = QUERY.replace("$userId", JSON.stringify(userId));
    const data = await graphql(query, { login: USER });

    const avatar = await fetchAvatarDataUri(data.user.avatarUrl);
    const s = summarize(data.user);
    s.avatar = avatar;
    if (!fs.existsSync("cards")) fs.mkdirSync("cards");
    fs.writeFileSync("cards/identity.svg", buildIdentity(s));
    fs.writeFileSync("cards/year.svg", buildYear(s));
    fs.writeFileSync("cards/work.svg", buildWork(s));
    console.log(
      `生成完了: contributions=${s.totalContributions}, commits=${s.commits}, langs=${s.topLangs
        .slice(0, 4)
        .map((l) => l.name)
        .join("/")}`
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
