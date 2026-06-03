// GitHub GraphQL API からコントリビューション統計を取得して stats.svg を生成する。
// 依存パッケージなし（Node 18+ の組み込み fetch を使用）。
//
// 必要な環境変数:
//   GITHUB_TOKEN  ... GraphQL API 用トークン（Actions の secrets.GITHUB_TOKEN で可）
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
    name
    login
    followers { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            contributionCount
            date
            weekday
          }
        }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) {
      totalCount
      nodes {
        stargazerCount
        primaryLanguage { name color }
      }
    }
  }
}
`;

async function fetchStats() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "stats-generator",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USER } }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API がエラーを返しました: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL エラー: ${JSON.stringify(json.errors)}`);
  }
  return json.data.user;
}

// 取得データから表示用の数値・言語ランキング・カレンダーを組み立てる
function summarize(user) {
  const c = user.contributionsCollection;
  const repos = user.repositories.nodes;

  const totalStars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);

  // 主要言語をリポジトリ数で集計
  const langCount = {};
  for (const r of repos) {
    const lang = r.primaryLanguage;
    if (!lang) continue;
    if (!langCount[lang.name]) langCount[lang.name] = { count: 0, color: lang.color };
    langCount[lang.name].count++;
  }
  const topLangs = Object.entries(langCount)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([name, v]) => ({ name, count: v.count, color: v.color || "#858585" }));

  return {
    name: user.name || user.login,
    login: user.login,
    followers: user.followers.totalCount,
    totalContributions: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    prs: c.totalPullRequestContributions,
    issues: c.totalIssueContributions,
    reviews: c.totalPullRequestReviewContributions,
    repoCount: user.repositories.totalCount,
    totalStars,
    topLangs,
    weeks: c.contributionCalendar.weeks,
  };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );

// コントリビューション数 → ヒートマップの色（GitHub 風の緑グラデーション）
function cellColor(count) {
  if (count <= 0) return "#161b22";
  if (count < 3) return "#0e4429";
  if (count < 6) return "#006d32";
  if (count < 10) return "#26a641";
  return "#39d353";
}

function buildSvg(s) {
  const W = 840;
  const H = 320;

  // ---- コントリビューションのヒートマップ ----
  const cell = 11;
  const gap = 3;
  const calX = 40;
  const calY = 150;
  let cells = "";
  s.weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day) => {
      const x = calX + wi * (cell + gap);
      const y = calY + day.weekday * (cell + gap);
      cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${cellColor(
        day.contributionCount
      )}"><title>${day.date}: ${day.contributionCount}</title></rect>`;
    });
  });

  // ---- 主要言語バー ----
  const langTotal = s.topLangs.reduce((sum, l) => sum + l.count, 0) || 1;
  let langBar = "";
  let langLegend = "";
  let bx = 40;
  const barW = 760;
  const barY = 268;
  s.topLangs.forEach((l, i) => {
    const w = (l.count / langTotal) * barW;
    langBar += `<rect x="${bx}" y="${barY}" width="${w}" height="10" fill="${l.color}"${
      i === 0 ? ' rx="3"' : ""
    }/>`;
    bx += w;
    const lx = 40 + i * 155;
    langLegend += `<circle cx="${lx + 5}" cy="${barY + 30}" r="5" fill="${l.color}"/>`;
    langLegend += `<text x="${lx + 16}" y="${barY + 34}" class="legend">${esc(l.name)}</text>`;
  });

  const stat = (x, label, value) => `
    <text x="${x}" y="92" class="value">${value}</text>
    <text x="${x}" y="112" class="label">${label}</text>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img">
  <style>
    .bg { fill: #0d1117; stroke: #30363d; stroke-width: 1; }
    .title { fill: #e6edf3; font: 600 22px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .subtitle { fill: #7d8590; font: 400 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .value { fill: #58a6ff; font: 700 24px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .label { fill: #7d8590; font: 400 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .section { fill: #e6edf3; font: 600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .legend { fill: #c9d1d9; font: 400 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  </style>
  <rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10"/>

  <text x="40" y="44" class="title">${esc(s.name)} の GitHub 統計</text>
  <text x="40" y="64" class="subtitle">@${esc(s.login)} ・ 過去1年間 ・ followers ${s.followers}</text>

  ${stat(40, "Contributions", s.totalContributions)}
  ${stat(200, "Commits", s.commits)}
  ${stat(340, "Pull Requests", s.prs)}
  ${stat(500, "Issues", s.issues)}
  ${stat(620, "Reviews", s.reviews)}
  ${stat(740, "Total Stars", s.totalStars)}

  <text x="40" y="140" class="section">直近のコントリビューション</text>
  ${cells}

  <text x="40" y="260" class="section">主要言語（リポジトリ数ベース）</text>
  ${langBar}
  ${langLegend}
</svg>`;
}

(async () => {
  try {
    const user = await fetchStats();
    const s = summarize(user);
    const svg = buildSvg(s);
    fs.writeFileSync("stats.svg", svg);
    console.log(`stats.svg を生成しました（総コントリビューション: ${s.totalContributions}）`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
