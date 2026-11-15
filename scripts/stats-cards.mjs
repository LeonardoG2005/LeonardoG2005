import { writeFile } from "node:fs/promises";

const TOKEN = process.env.GITHUB_TOKEN;
const USER = process.env.GITHUB_USER || "LeonardoG2005";
const OUT_DIR = process.env.OUT_DIR || "profile";
const LANGS_COUNT = 8;

// Palette and typography copied from the streak card so all three match.
const C = {
  bg: "#0d1117",
  title: "#FB8C00",
  value: "#FEFEFE",
  label: "#9E9E9E",
  track: "#21262d",
};
const FONT = `font-family='"Segoe UI", Ubuntu, sans-serif'`;
const W = 410;
const H = 195;

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

async function fetchData() {
  const { user } = await gql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection { contributionYears }
        pullRequests { totalCount }
        issues { totalCount }
        repositoriesContributedTo(
          includeUserRepositories: true
          contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, PULL_REQUEST_REVIEW, REPOSITORY]
        ) { totalCount }
      }
    }`,
    { login: USER },
  );

  const years = user.contributionsCollection.contributionYears;
  const yearFields = years
    .map((y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") { totalCommitContributions }`)
    .join("\n");
  const commitsData = await gql(`query($login: String!) { user(login: $login) { ${yearFields} } }`, { login: USER });
  const commits = years.reduce((sum, y) => sum + commitsData.user[`y${y}`].totalCommitContributions, 0);

  const repos = [];
  let after = null;
  do {
    const { user: page } = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          repositories(ownerAffiliations: OWNER, first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isFork
              stargazerCount
              languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login: USER, after },
    );
    repos.push(...page.repositories.nodes);
    after = page.repositories.pageInfo.hasNextPage ? page.repositories.pageInfo.endCursor : null;
  } while (after);

  const languages = new Map();
  for (const repo of repos.filter((r) => !r.isFork)) {
    for (const { size, node } of repo.languages.edges) {
      const entry = languages.get(node.name) || { name: node.name, color: node.color || "#8b949e", size: 0 };
      entry.size += size;
      languages.set(node.name, entry);
    }
  }

  return {
    stats: {
      commits,
      prs: user.pullRequests.totalCount,
      issues: user.issues.totalCount,
      stars: repos.reduce((sum, r) => sum + r.stargazerCount, 0),
      repos: repos.length,
      contributed: user.repositoriesContributedTo.totalCount,
    },
    languages: [...languages.values()].sort((a, b) => b.size - a.size).slice(0, LANGS_COUNT),
  };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
const fmt = (n) => n.toLocaleString("en-US");

function card(title, body) {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' width='${W}px' height='${H}px'>
  <rect fill='${C.bg}' rx='4.5' x='0.5' y='0.5' width='${W - 1}' height='${H - 1}'/>
  <text x='25' y='36' fill='${C.title}' ${FONT} font-weight='700' font-size='14px'>${esc(title)}</text>
${body}
</svg>
`;
}

function statsCard(s) {
  const items = [
    ["Commits", s.commits],
    ["Pull Requests", s.prs],
    ["Issues", s.issues],
    ["Repositories", s.repos],
    ["Contributed To", s.contributed],
    ["Stars Earned", s.stars],
  ];
  const colW = (W - 50) / 3;
  const body = items
    .map(([label, value], i) => {
      const x = 25 + colW * (i % 3) + colW / 2;
      const y = i < 3 ? 86 : 150;
      return `  <text x='${x}' y='${y}' text-anchor='middle' fill='${C.value}' ${FONT} font-weight='700' font-size='24px'>${fmt(value)}</text>
  <text x='${x}' y='${y + 20}' text-anchor='middle' fill='${C.label}' ${FONT} font-size='12px'>${esc(label)}</text>`;
    })
    .join("\n");
  return card("GitHub Stats", body);
}

function languagesCard(langs) {
  const total = langs.reduce((sum, l) => sum + l.size, 0);
  const barW = W - 50;
  let x = 25;
  const segments = langs
    .map((l) => {
      const w = (l.size / total) * barW;
      const rect = `    <rect x='${x.toFixed(2)}' y='52' width='${w.toFixed(2)}' height='8' fill='${l.color}'/>`;
      x += w;
      return rect;
    })
    .join("\n");

  const colW = barW / 2;
  const legend = langs
    .map((l, i) => {
      const cx = 25 + colW * Math.floor(i / 4);
      const cy = 90 + (i % 4) * 24;
      const pct = ((l.size / total) * 100).toFixed(1);
      return `  <circle cx='${cx + 5}' cy='${cy - 4}' r='5' fill='${l.color}'/>
  <text x='${cx + 18}' y='${cy}' fill='${C.value}' ${FONT} font-size='13px'>${esc(l.name)}</text>
  <text x='${cx + colW - 20}' y='${cy}' text-anchor='end' fill='${C.label}' ${FONT} font-size='12px'>${pct}%</text>`;
    })
    .join("\n");

  const body = `  <clipPath id='bar'><rect x='25' y='52' width='${barW}' height='8' rx='4'/></clipPath>
  <g clip-path='url(#bar)'>
    <rect x='25' y='52' width='${barW}' height='8' fill='${C.track}'/>
${segments}
  </g>
${legend}`;
  return card("Top Languages", body);
}

const data = await fetchData();
await writeFile(`${OUT_DIR}/stats.svg`, statsCard(data.stats));
await writeFile(`${OUT_DIR}/languages.svg`, languagesCard(data.languages));
console.log(JSON.stringify({ stats: data.stats, languages: data.languages.map((l) => l.name) }));
