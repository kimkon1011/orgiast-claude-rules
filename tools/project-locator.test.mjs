import test from "node:test";
import assert from "node:assert/strict";
import {
  collectProjectLocations,
  mergeProjectLocations,
  parseVercelProjects,
} from "./project-locator.mjs";

const vercelFixture = `Fetching projects in kimkon-s-projects
> Projects found under kimkon-s-projects  [1s]

  Project Name                Latest Production URL                          Updated   Node Version   
  purchasing-management-app   https://purchasing-management-app.vercel.app   53m       24.x           
  godo-setsumeikai            https://godo-setsumeikai.vercel.app            1h        24.x           
  tanom-ai                    https://ai-daikodo.com                         1h        24.x           
  gakkai-sponsor              https://sponsor.gakkaisupport.jp               2d        24.x           `;

test("Vercel Windows output returns project name, production URL, and scope", () => {
  const rows = parseVercelProjects(vercelFixture);
  assert.deepEqual(rows, [
    {
      name: "purchasing-management-app",
      prodUrl: "purchasing-management-app.vercel.app",
      scope: "kimkon-s-projects",
    },
    {
      name: "godo-setsumeikai",
      prodUrl: "godo-setsumeikai.vercel.app",
      scope: "kimkon-s-projects",
    },
    { name: "tanom-ai", prodUrl: "ai-daikodo.com", scope: "kimkon-s-projects" },
    {
      name: "gakkai-sponsor",
      prodUrl: "sponsor.gakkaisupport.jp",
      scope: "kimkon-s-projects",
    },
  ]);
});

test("merge uses exact repository-name match and injects JST update time", () => {
  const repos = [
    { name: "app", nameWithOwner: "kim/app", visibility: "PRIVATE" },
  ];
  const vercel = [
    { name: "app-old", prodUrl: "wrong" },
    { name: "app", prodUrl: "right" },
  ];
  const local = [
    {
      repoName: "app",
      project: "local-app",
      lastCommitAt: "2026-08-28",
      lastCommitSubject: "ok",
    },
  ];
  const rows = mergeProjectLocations(
    repos,
    vercel,
    local,
    "PC-A",
    new Date("2026-08-28T01:23:00Z"),
  );
  const row = rows.find((item) => item.repo === "kim/app");
  assert.equal(row.vercelProject, "app");
  assert.equal(row.prodUrl, "right");
  assert.equal(row.devPc, "PC-A");
  assert.equal(row.updatedAt, "2026-08-28 10:23");
});

test("unmatched Vercel project remains as a repo-less ledger row", () => {
  const rows = mergeProjectLocations(
    [],
    [{ name: "orphan", prodUrl: "orphan.vercel.app", scope: "team-a" }],
    [],
    "PC-A",
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    {
      project: rows[0].project,
      repo: rows[0].repo,
      vercelProject: rows[0].vercelProject,
      vercelScope: rows[0].vercelScope,
    },
    {
      project: "orphan",
      repo: "",
      vercelProject: "orphan",
      vercelScope: "team-a",
    },
  );
});

test("collector lists authenticated user and every GitHub organization", () => {
  const owners = [];
  const runner = (command, args) => {
    if (args[0] === "auth")
      return {
        code: 0,
        stdout: "Logged in to github.com account kim (keyring)",
        stderr: "",
      };
    if (args[0] === "api")
      return { code: 0, stdout: "org-one\norg-two\n", stderr: "" };
    if (args[0] === "repo") {
      owners.push(args[2]);
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            name: `${args[2]}-repo`,
            nameWithOwner: `${args[2]}/${args[2]}-repo`,
          },
        ]),
        stderr: "",
      };
    }
    if (command === "vercel")
      return { code: 1, stdout: "", stderr: "not installed" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const rows = collectProjectLocations({
    runner,
    projectsDir: "/definitely/missing",
    now: new Date("2026-08-28T00:00:00Z"),
  });
  assert.deepEqual(owners, ["kim", "org-one", "org-two"]);
  assert.equal(rows.length, 3);
});

test("organization lookup failure does not discard personal repositories", () => {
  const runner = (command, args) => {
    if (args[0] === "auth")
      return {
        code: 0,
        stdout: "Logged in to github.com account kim (keyring)",
        stderr: "",
      };
    if (args[0] === "api") return { code: 1, stdout: "", stderr: "forbidden" };
    if (args[0] === "repo")
      return {
        code: 0,
        stdout: '[{"name":"app","nameWithOwner":"kim/app"}]',
        stderr: "",
      };
    if (command === "vercel") return { code: 1, stdout: "", stderr: "" };
    throw new Error("unexpected command");
  };
  const rows = collectProjectLocations({
    runner,
    projectsDir: "/definitely/missing",
  });
  assert.equal(rows[0].repo, "kim/app");
});

// 回帰テスト: Vercel CLI は一覧を stderr に書く。stdout だけ読むと終了コード0のまま
// 0件になり、本番URLを持つプロジェクトが台帳から丸ごと消える(2026-08-28 実測)。
test("Vercel の一覧が stderr にしか出なくても取り込む", () => {
  const runner = (command, args) => {
    if (command === "gh" && args[0] === "auth")
      return { code: 0, stdout: "Logged in to github.com account kim (keyring)", stderr: "" };
    if (command === "gh" && args[0] === "api") return { code: 0, stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "repo")
      return { code: 0, stdout: '[{"name":"app","nameWithOwner":"kim/app"}]', stderr: "" };
    if (command === "vercel") return { code: 0, stdout: "", stderr: vercelFixture };
    throw new Error("unexpected command");
  };
  const rows = collectProjectLocations({ runner, projectsDir: "/definitely/missing", label: "PC-A" });
  const orphan = rows.find((row) => row.project === "gakkai-sponsor");
  assert.ok(orphan, "GitHub と同名でない Vercel プロジェクトが台帳に出ていない");
  assert.equal(orphan.repo, "");
  assert.equal(orphan.vercelScope, "kimkon-s-projects");
});
