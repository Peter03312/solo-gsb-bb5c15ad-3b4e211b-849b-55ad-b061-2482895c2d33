/**
 * 端到端业务流程测试（对已运行的服务器执行）。
 * 用法: BASE=http://127.0.0.1:3210 node scripts/e2e.cjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

async function req(method, path, token, body, expectStatus = 200) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  const acceptable = expectStatus === 200 ? [200, 201] : [expectStatus];
  if (!acceptable.includes(res.status)) {
    throw new Error(`${method} ${path} 期望 ${expectStatus} 得到 ${res.status}: ${text}`);
  }
  return json;
}
const J = (p, t, b, s) => req('POST', p, t, b, s);
const G = (p, t, s = 200) => req('GET', p, t, undefined, s);
const D = (p, t, s = 200) => req('DELETE', p, t, undefined, s);

async function login(u, p) {
  const r = await J('/api/login', null, { username: u, password: p }, 200);
  return r.token;
}

async function main() {
  console.log('— 认证与越权 —');
  await J('/api/login', null, { username: 'director', password: 'wrong' }, 401);
  const director = await login('director', 'director123');
  const lin = await login('lin', 'actor123');
  const chen = await login('chen', 'actor123');
  await G('/api/me', null, 401);
  // 演员不能建剧本/看演员名册
  await J('/api/plays', lin, { title: 'x' }, 403);
  await G('/api/actors', lin, 403);
  check('错误密码 401 / 未登录 401 / 演员越权导演接口 403', true);

  console.log('— 种子数据 —');
  const { plays } = await G('/api/plays', director);
  check('种子剧本存在', plays.length >= 1);
  const playId = plays[0].id;
  const detail = await G(`/api/plays/${playId}`, director);
  check('首版已发布', detail.play.latestVersionId === 1);
  check('种子台词 7 条', detail.lines.length === 7, String(detail.lines.length));
  // 已发布后直接改行台词被拒
  await req('PATCH', `/api/lines/${detail.lines[0].id}`, director, { text: 'x' }, 409);
  check('发布后禁止直接改现行文本（409）', true);

  console.log('— 无效版本 / 越权访问剧本 —');
  await G('/api/versions/99999', director, 404);
  // 周海未派角应 403；陈默在种子排练中被派了船员，可以访问
  const zhou = await login('zhou', 'actor123');
  await G(`/api/plays/${playId}`, zhou, 403);
  check('未派角演员访问剧本 403；已派角演员可访问', true);
  const chenPlay = await G(`/api/plays/${playId}`, chen, 200);
  check('已派角演员可看剧本', !!chenPlay.play);
  check('演员剧本详情只含所派角色台词', chenPlay.lines.every((l) => {
    const r = detail.roles.find((x) => x.id === l.roleId);
    return r.code === 'SAILOR';
  }) && chenPlay.lines.length >= 2, String(chenPlay.lines.length));
  const chenV1 = await G('/api/versions/1', chen, 200);
  check('演员版本视图只含所派角色台词', chenV1.lines.every((l) => l.roleCode === 'SAILOR') && chenV1.lines.length === 3, String(chenV1.lines.length));

  console.log('— 修订提交：必须标明原文且与基准一致 —');
  const line1 = detail.lines[0]; // 守塔人 s1
  const line2 = detail.lines[1]; // 船员 s1
  // 原文错误 -> 409 OLD_TEXT_MISMATCH
  const badRev = await J(`/api/plays/${playId}/revisions`, director, {
    title: '错误原文', baseVersionId: 1, items: [],
  }, 201);
  await J(`/api/revisions/${badRev.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: '瞎写的原文', newText: '新的文本',
  }, 409);
  check('原文与基准不一致时拒绝提交', true);

  // 修订 A：改 line1
  const revA = await J(`/api/plays/${playId}/revisions`, director, { title: '修订A-浪高', baseVersionId: 1 }, 201);
  await J(`/api/revisions/${revA.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚的浪比昨天高得多，灯油还够烧到后半夜。',
  });
  // 修订 B：改 line2（与 A 互不冲突）
  const revB = await J(`/api/plays/${playId}/revisions`, director, { title: '修订B-船舵' }, 201);
  await J(`/api/revisions/${revB.id}/items`, director, {
    action: 'modify', lineId: line2.id, oldText: line2.text, newText: '船舵彻底失灵了，我们只能跟着潮水漂。',
  });
  // 修订 C：也改 line1，同样基于 v1 原文（与 A 冲突，内容不同）
  const revC = await J(`/api/plays/${playId}/revisions`, director, { title: '修订C-同句不同改' }, 201);
  await J(`/api/revisions/${revC.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚风浪不小，但灯油足够撑到天明。',
  });
  // 修订 D：和 A 完全相同的改动（幂等，不算冲突）
  const revD = await J(`/api/plays/${playId}/revisions`, director, { title: '修订D-同改相同' }, 201);
  await J(`/api/revisions/${revD.id}/items`, director, {
    action: 'modify', lineId: line1.id, oldText: line1.text, newText: '今晚的浪比昨天高得多，灯油还够烧到后半夜。',
  });

  console.log('— 发布 A+B+C：有冲突，整体不生效 —');
  const conflictPub = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revA.id, revB.id, revC.id], note: '尝试1',
  }, 409);
  check('冲突时返回 409', conflictPub.error === 'PUBLISH_CONFLICT');
  check('冲突条目数为 1（C 撞 A）', conflictPub.conflicts.length === 1, JSON.stringify(conflictPub.conflicts));
  check('冲突指明 line1 与修订', conflictPub.conflicts[0].lineId === line1.id && conflictPub.conflicts[0].revisionId === revC.id);
  const stillV1 = await G(`/api/plays/${playId}`, director);
  check('冲突后未生成新版本', stillV1.play.latestVersionId === 1);
  check('冲突后修订仍是 open', (await G(`/api/revisions/${revA.id}`, director)).status === 'open');

  console.log('— 发布 A+D+B：相同改动幂等，互不冲突，合成 v2 —');
  const pub2 = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revA.id, revD.id, revB.id], note: 'v2 合入',
  }, 201);
  check('生成 v2', pub2.newVersion.versionNo === 2);
  check('三个修订都标记 merged', (await G(`/api/revisions/${revD.id}`, director)).status === 'merged');
  const v2 = await G('/api/versions/2', director);
  const v2line1 = v2.lines.find((l) => l.lineId === line1.id);
  const v2line2 = v2.lines.find((l) => l.lineId === line2.id);
  check('v2 含 A 的新文', v2line1.text.includes('后半夜'));
  check('v2 含 B 的新文', v2line2.text.includes('彻底失灵'));
  // v1 快照未变（不可改写）
  const v1 = await G('/api/versions/1', director);
  check('v1 快照保持原文', v1.lines.find((l) => l.lineId === line1.id).text === line1.text);

  console.log('— 修订 C 基于旧原文：发布时核对现行文本，报 text_changed —');
  const pub3 = await J(`/api/plays/${playId}/publish`, director, {
    revisionIds: [revC.id],
  }, 409);
  check('C 报 text_changed 冲突', pub3.conflicts[0].kind === 'text_changed');
  check('冲突含原文与现行文本', pub3.conflicts[0].baseText === line1.text && pub3.conflicts[0].currentText.includes('后半夜'));

  console.log('— 删除修订与发布 —');
  const revDel = await J(`/api/plays/${playId}/revisions`, director, { title: '删一句' }, 201);
  await J(`/api/revisions/${revDel.id}/items`, director, {
    action: 'delete', lineId: line2.id, oldText: '船舵彻底失灵了，我们只能跟着潮水漂。',
  });
  const pub4 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revDel.id] }, 201);
  check('删除后生成 v3', pub4.newVersion.versionNo === 3);
  const v3 = await G('/api/versions/3', director);
  check('v3 中该句已删除', !v3.lines.find((l) => l.lineId === line2.id));
  check('v2 中该句仍在（历史版本不变）', !!(await G('/api/versions/2', director)).lines.find((l) => l.lineId === line2.id));
  // 再拿一个基于 v2 原文想改已删句子的修订 -> line_deleted
  const revZ = await J(`/api/plays/${playId}/revisions`, director, { title: '改已删句', baseVersionId: 2 }, 201);
  // 提交时基准 v2 里还在，允许提交
  await J(`/api/revisions/${revZ.id}/items`, director, {
    action: 'modify', lineId: line2.id, oldText: '船舵彻底失灵了，我们只能跟着潮水漂。', newText: 'x',
  });
  const pub5 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revZ.id] }, 409);
  check('现行已删 -> line_deleted 冲突', pub5.conflicts[0].kind === 'line_deleted');

  console.log('— 新增台词修订 —');
  const revAdd = await J(`/api/plays/${playId}/revisions`, director, { title: '加一句' }, 201);
  await J(`/api/revisions/${revAdd.id}/items`, director, {
    action: 'add', sceneId: detail.scenes[0].id, roleId: detail.roles[1].id, newText: '快看，灯塔的光转过来了！',
  });
  const pub6 = await J(`/api/plays/${playId}/publish`, director, { revisionIds: [revAdd.id] }, 201);
  check('新增合入 v4', pub6.newVersion.versionNo === 4);
  const v4 = await G('/api/versions/4', director);
  check('v4 含新增句', v4.lines.some((l) => l.text === '快看，灯塔的光转过来了！'));
  // 作废 open 修订
  await J(`/api/revisions/${revC.id}/abandon`, director, {}, 200);
  await J(`/api/revisions/${revC.id}/abandon`, director, {}, 400);
  check('作废幂等保护（再次作废 400）', true);

  console.log('— 版本不可改写（数据库触发器） —');
  // 用独立内存库自检触发器（不依赖本地 ./data 目录的残留状态）
  process.env.DB_PATH = ':memory:';
  const { db: memdb } = require('/workspace/src/db.js');
  const tPlay = memdb.prepare('INSERT INTO plays (title) VALUES (?)').run('触发器自检').lastInsertRowid;
  const tVer = memdb.prepare('INSERT INTO versions (play_id, version_no) VALUES (?, 1)').run(tPlay).lastInsertRowid;
  memdb.prepare('INSERT INTO version_lines (version_id, line_id, scene_id, role_id, seq, text) VALUES (?, 1, 1, 1, 1, ?)').run(tVer, 'x');
  let blockedUpdate = false;
  try { memdb.prepare('UPDATE versions SET note = ? WHERE id = ?').run('hacked', tVer); } catch { blockedUpdate = true; }
  let blockedVL = false;
  try { memdb.prepare('UPDATE version_lines SET text = ? WHERE version_id = ?').run('h', tVer); } catch { blockedVL = true; }
  let blockedDel = false;
  try { memdb.prepare('DELETE FROM versions WHERE id = ?').run(tVer); } catch { blockedDel = true; }
  check('versions UPDATE/DELETE 与 version_lines UPDATE 被触发器拒绝', blockedUpdate && blockedVL && blockedDel);

  console.log('— 排练：创建固定版本、派角、确认、换版 —');
  // 无效版本创建排练
  await J(`/api/plays/${playId}/rehearsals`, director, { versionId: 99999 }, 400);
  const reh = await J(`/api/plays/${playId}/rehearsals`, director, { versionId: 1, name: '测试排练固定v1' }, 201);
  check('排练创建时固定 v1', reh.versionId === 1);
  const actors = (await G('/api/actors', director)).actors;
  const zhouId = actors.find((a) => a.username === 'zhou').id;
  const linId = actors.find((a) => a.username === 'lin').id;
  const keeperRole = detail.roles.find((r) => r.code === 'KEEPER').id;
  const sailorRole = detail.roles.find((r) => r.code === 'SAILOR').id;
  await J(`/api/rehearsals/${reh.id}/cast`, director, { roleId: keeperRole, actorId: linId }, 201);
  // 演员不能看未派角排练
  await G(`/api/rehearsals/${reh.id}/script`, chen, 403);
  // 演员不能给别人的角色确认
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: sailorRole, sceneId: detail.scenes[0].id }, 403);
  // 无效场次确认
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: 99999 }, 400);
  check('越权确认 / 无效场次被拒', true);

  // 林晚确认两个场次（v1 守塔人：s1 第1句、s2 第5/7句）
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: detail.scenes[0].id });
  await J(`/api/rehearsals/${reh.id}/confirm`, lin, { roleId: keeperRole, sceneId: detail.scenes[1].id });
  let rehView = await G(`/api/rehearsals/${reh.id}`, director);
  check('林晚两场确认后，其角色无待确认', !rehView.pending.some((p) => p.actorId === linId));

  // 换版到 v2：守塔人 s1 文本变了，s2 没变 -> s1 重新待确认，s2 保留
  const sw = await J(`/api/rehearsals/${reh.id}/switch-version`, director, { versionId: 2 }, 200);
  const linPend = sw.pending.filter((p) => p.actorId === linId);
  check('换版 v2：守塔人 s1 需重新确认', linPend.some((p) => p.sceneId === detail.scenes[0].id), JSON.stringify(linPend));
  check('换版 v2：守塔人 s2（文本未变）不需确认', !linPend.some((p) => p.sceneId === detail.scenes[1].id));

  // 改派：守塔人改派给周海 -> 原林晚确认不计入；周海两场都待确认
  await J(`/api/rehearsals/${reh.id}/cast`, director, { roleId: keeperRole, actorId: zhouId }, 200);
  rehView = await G(`/api/rehearsals/${reh.id}`, director);
  const zhouPend = rehView.pending.filter((p) => p.actorId === zhouId);
  check('改派后新演员待确认（s1）', zhouPend.some((p) => p.sceneId === detail.scenes[0].id));
  // s2 保留了林晚的旧确认 -> 周海看到的原因是“已改派，原确认不计入”
  const s2p = zhouPend.find((p) => p.sceneId === detail.scenes[1].id);
  check('s2 标注“原演员确认不计入”', !!s2p && s2p.reason.includes('改派'), s2p?.reason);
  check('改派后原演员不再出现在待确认（她已无角色）', !rehView.pending.some((p) => p.actorId === linId));
  // 周海用演员视角看稿，只能看到守塔人台词
  const zhouToken = await login('zhou', 'actor123');
  const script = await G(`/api/rehearsals/${reh.id}/script`, zhouToken);
  check('演员排练稿只含所派角色', script.lines.every((l) => l.roleId === keeperRole) && script.lines.length > 0);

  // 换版到 v3（删掉了船员的句子）；未派船员，只看守塔人：v3 守塔人内容与 v2 相同 => 无需再确认
  // 先把 s1 确认掉
  await J(`/api/rehearsals/${reh.id}/confirm`, zhouToken, { roleId: keeperRole, sceneId: detail.scenes[0].id });
  await J(`/api/rehearsals/${reh.id}/confirm`, zhouToken, { roleId: keeperRole, sceneId: detail.scenes[1].id });
  const sw3 = await J(`/api/rehearsals/${reh.id}/switch-version`, director, { versionId: 3 }, 200);
  check('v2→v3 守塔人无文本变化 => 无待确认', !sw3.pending.some((p) => p.actorId === zhouId), JSON.stringify(sw3.pending));

  console.log('— 待确认演员与冲突详情展示 —');
  const dash = await G('/api/dashboard', director);
  check('总览含每个排练的 pending', Array.isArray(dash.rehearsals[0].pending));
  check('总览含冲突详情', dash.recentConflicts.some((c) => c.details.length > 0));
  const attempts = (await G(`/api/plays/${playId}/publish-attempts`, director)).attempts;
  check('发布尝试历史含成功与冲突两种', attempts.some((a) => a.hadConflict) && attempts.some((a) => !a.hadConflict));

  console.log('— 排练日程：带时区时段、参与者、待补派 —');
  const chenId = actors.find((a) => a.username === 'chen').id;
  // 专用剧本：sc1/sc2/scEmpty；角色 RA/RB
  const p2 = await J('/api/plays', director, { title: '日程测试剧' }, 201);
  const sc1 = (await J(`/api/plays/${p2.id}/scenes`, director, { code: 'A1', title: '码头' }, 201)).id;
  const sc2 = (await J(`/api/plays/${p2.id}/scenes`, director, { code: 'A2', title: '船舱' }, 201)).id;
  const scEmpty = (await J(`/api/plays/${p2.id}/scenes`, director, { code: 'A3', title: '空场' }, 201)).id;
  const roleA = (await J(`/api/plays/${p2.id}/roles`, director, { code: 'RA', name: '甲' }, 201)).id;
  const roleB = (await J(`/api/plays/${p2.id}/roles`, director, { code: 'RB', name: '乙' }, 201)).id;
  await J(`/api/plays/${p2.id}/lines`, director, { sceneId: sc1, roleId: roleA, text: '甲一句一', seq: 1 }, 201);
  await J(`/api/plays/${p2.id}/lines`, director, { sceneId: sc2, roleId: roleA, text: '甲二句一', seq: 1 }, 201);
  await J(`/api/plays/${p2.id}/lines`, director, { sceneId: sc2, roleId: roleB, text: '乙二句一', seq: 2 }, 201);
  const pv1 = (await J(`/api/plays/${p2.id}/publish-initial`, director, { note: 'v1' }, 201)).version.id;
  // v2：给乙在 sc1 加一句（换版后乙才在 sc1 有台词）
  const revAddB = await J(`/api/plays/${p2.id}/revisions`, director, { title: '乙加 sc1 台词' }, 201);
  await J(`/api/revisions/${revAddB.id}/items`, director, { action: 'add', sceneId: sc1, roleId: roleB, newText: '乙一句一', seq: 2 }, 201);
  const pv2 = (await J(`/api/plays/${p2.id}/publish`, director, { revisionIds: [revAddB.id] }, 201)).newVersion.id;
  // v3：删掉 sc2 全部台词（换版后 sc2 场次无台词 -> 既有安排待调整）
  const p2detail = await G(`/api/plays/${p2.id}`, director);
  const revDel2 = await J(`/api/plays/${p2.id}/revisions`, director, { title: '清空 sc2' }, 201);
  await J(`/api/revisions/${revDel2.id}/items`, director, { action: 'delete', lineId: p2detail.lines.find((l) => l.text === '甲二句一').id, oldText: '甲二句一' }, 201);
  await J(`/api/revisions/${revDel2.id}/items`, director, { action: 'delete', lineId: p2detail.lines.find((l) => l.text === '乙二句一').id, oldText: '乙二句一' }, 201);
  const pv3 = (await J(`/api/plays/${p2.id}/publish`, director, { revisionIds: [revDel2.id] }, 201)).newVersion.id;

  // RH_A 固定 v2：甲=林晚，乙=陈默
  const rhA = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练A' }, 201)).id;
  await J(`/api/rehearsals/${rhA}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhA}/cast`, director, { roleId: roleB, actorId: chenId }, 201);

  // 校验：演员越权 / 排练不存在 / 无时区 / 结束不晚于开始 / 场次无效 / 场次当前版本无台词
  await J(`/api/rehearsals/${rhA}/schedules`, lin, { sceneId: sc1, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 403);
  await J('/api/rehearsals/99999/schedules', director, { sceneId: sc1, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 404);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T11:00:00+08:00', endAt: '2030-01-01T10:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: 99999, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: detail.scenes[0].id, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: scEmpty, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 400);
  check('日程：越权/无排练/无时区/起止颠倒/无效场次/无台词场次均被拒', true);

  // 正常创建：参与者=当前版本本场有台词且已派角的演员
  const schA1 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:00:00+08:00', endAt: '2030-01-01T11:00:00+08:00' }, 201)).schedule;
  check('日程参与者为有台词且已派角的演员', schA1.participants.length === 2 && schA1.participants.every((p) => [linId, chenId].includes(p.actorId)), JSON.stringify(schA1.participants));
  check('全部派角时无待补派', schA1.pendingCast.length === 0);
  // 端点相接不算重叠
  const schA2 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc2, startAt: '2030-01-01T11:00:00+08:00', endAt: '2030-01-01T12:00:00+08:00' }, 201)).schedule;
  check('端点相接（11:00 接 11:00）不算重叠', !!schA2.id);
  // 重叠 -> 409，返回冲突演员与时段
  const ov = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:30:00+08:00', endAt: '2030-01-01T11:30:00+08:00' }, 409);
  check('时段重叠返回 SCHEDULE_CONFLICT', ov.error === 'SCHEDULE_CONFLICT');
  check('冲突详情含冲突演员与时段', ov.details.conflicts.some((c) => c.actorId === linId && c.overlapsWith.id === schA1.id), JSON.stringify(ov.details));
  // 不同时区表示的同一时段也判重叠（10:30+09:00 = 09:30+08:00）
  const ovTz = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T10:30:00+09:00', endAt: '2030-01-01T12:30:00+09:00' }, 409);
  check('跨时区同一时间轴同样判重叠', ovTz.error === 'SCHEDULE_CONFLICT');
  // Z 时区写法，端点相接于 schA2 末端（12:00+08:00 = 04:00Z）
  const schA3 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-01T04:00:00Z', endAt: '2030-01-01T05:00:00Z' }, 201)).schedule;
  check('Z 时区可提交且端点相接不冲突', !!schA3.id);

  console.log('— 日程：待补派 / 跨排练冲突 / 派角冲突 —');
  // RH_B 固定 v1：乙=陈默（v1 中乙在 sc1 无台词）
  const rhB = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '日程排练B' }, 201)).id;
  await J(`/api/rehearsals/${rhB}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const schB1 = (await J(`/api/rehearsals/${rhB}/schedules`, director, { sceneId: sc1, startAt: '2030-01-02T10:00:00+08:00', endAt: '2030-01-02T11:00:00+08:00' }, 201)).schedule;
  check('当前版本无台词角色不参与（参与者为空）', schB1.participants.length === 0);
  check('未派角色列为待补派，不阻止安排', schB1.pendingCast.some((r) => r.roleId === roleA));
  const schB2 = (await J(`/api/rehearsals/${rhB}/schedules`, director, { sceneId: sc2, startAt: '2030-01-02T10:00:00+08:00', endAt: '2030-01-02T11:00:00+08:00' }, 201)).schedule;
  check('参与者按排练当前版本计算', schB2.participants.some((p) => p.actorId === chenId));
  // 跨排练冲突：陈默在 RH_B 的 sc2 有时段，RH_A 同时段不可再排
  const ovReh = await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-02T10:30:00+08:00', endAt: '2030-01-02T11:30:00+08:00' }, 409);
  check('跨排练的演员重叠也冲突', ovReh.details.conflicts.some((c) => c.actorId === chenId && c.overlapsWith.id === schB2.id));
  const schA4 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-02T11:00:00+08:00', endAt: '2030-01-02T12:00:00+08:00' }, 201)).schedule;
  check('跨排练端点相接可安排', !!schA4.id);

  // 派角冲突：RH_C 甲=周海并排好时段；陈默在 RH_A 同时段有安排 -> 派角整次拒绝
  const rhC = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练C' }, 201)).id;
  await J(`/api/rehearsals/${rhC}/cast`, director, { roleId: roleA, actorId: zhouId }, 201);
  const schC1 = (await J(`/api/rehearsals/${rhC}/schedules`, director, { sceneId: sc1, startAt: '2030-01-03T10:00:00+08:00', endAt: '2030-01-03T11:00:00+08:00' }, 201)).schedule;
  check('待补派列出未派角的有台词角色', schC1.pendingCast.some((r) => r.roleId === roleB));
  const schA5 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-03T10:30:00+08:00', endAt: '2030-01-03T11:30:00+08:00' }, 201)).schedule;
  const castConflict = await J(`/api/rehearsals/${rhC}/cast`, director, { roleId: roleB, actorId: chenId }, 409);
  check('派角与既有时段重叠 -> 整次拒绝', castConflict.error === 'SCHEDULE_CONFLICT' && castConflict.details.conflicts.some((c) => c.actorId === chenId));
  const rhCsched = await G(`/api/rehearsals/${rhC}/schedules`, director);
  check('派角被拒绝后仍未派角', rhCsched.schedules.find((s) => s.id === schC1.id).pendingCast.some((r) => r.roleId === roleB));
  // 取消冲突时段后派角成功
  await J(`/api/rehearsals/${rhA}/schedules/${schA5.id}/cancel`, director, {}, 200);
  await J(`/api/rehearsals/${rhC}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  check('取消冲突时段后派角成功', true);

  console.log('— 日程：换版冲突 / 失败换版不动版本与确认 / 待调整 —');
  // 陈默先确认 RH_B 的 sc2（v1），验证失败换版不影响确认
  await J(`/api/rehearsals/${rhB}/confirm`, chen, { roleId: roleB, sceneId: sc2 }, 200);
  // RH_B v1->v2：schB1(sc1) 将纳入陈默，与同排练同时段 schB2(sc2) 冲突
  const swFail = await J(`/api/rehearsals/${rhB}/switch-version`, director, { versionId: pv2 }, 409);
  check('换版后参与者重叠 -> 换版整次拒绝', swFail.error === 'SCHEDULE_CONFLICT' && swFail.details.conflicts.some((c) => c.actorId === chenId), JSON.stringify(swFail));
  const rhBAfter = await G(`/api/rehearsals/${rhB}`, director);
  check('失败的换版不改变版本', rhBAfter.rehearsal.versionId === pv1);
  check('失败的换版不改变确认', !rhBAfter.pending.some((p) => p.actorId === chenId));
  // 调整 schB1 到不相交时段后，换版成功
  const adjB1 = await req('PATCH', `/api/rehearsals/${rhB}/schedules/${schB1.id}`, director, { startAt: '2030-01-02T12:00:00+08:00', endAt: '2030-01-02T13:00:00+08:00' }, 200);
  check('调整时段成功', adjB1.schedule.status === 'active');
  const swOk = await J(`/api/rehearsals/${rhB}/switch-version`, director, { versionId: pv2 }, 200);
  check('冲突解除后换版成功', swOk.rehearsal.versionId === pv2);
  check('换版后文本未变的确认保留（sc2）', !swOk.pending.some((p) => p.actorId === chenId && p.sceneId === sc2));
  check('换版后新增台词的场次需确认（sc1）', swOk.pending.some((p) => p.actorId === chenId && p.sceneId === sc1));

  // RH_D 固定 v2 -> v3：sc2 在 v3 无台词 -> 既有安排待调整，不计入冲突
  const rhD = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练D' }, 201)).id;
  await J(`/api/rehearsals/${rhD}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  const schD1 = (await J(`/api/rehearsals/${rhD}/schedules`, director, { sceneId: sc2, startAt: '2030-01-04T10:00:00+08:00', endAt: '2030-01-04T11:00:00+08:00' }, 201)).schedule;
  const swD = await J(`/api/rehearsals/${rhD}/switch-version`, director, { versionId: pv3 }, 200);
  check('换版后无台词的既有安排标为待调整', swD.needsAdjustmentSchedules.includes(schD1.id), JSON.stringify(swD.needsAdjustmentSchedules));
  // 待调整不计入冲突：林晚在 schD1 同时段可另排
  const schA6 = (await J(`/api/rehearsals/${rhA}/schedules`, director, { sceneId: sc1, startAt: '2030-01-04T10:30:00+08:00', endAt: '2030-01-04T11:30:00+08:00' }, 201)).schedule;
  check('待调整时段不计入冲突', !!schA6.id);
  // 待调整 -> 调整回有台词场次但时间重叠 -> 409；调到空档 -> 恢复有效
  await req('PATCH', `/api/rehearsals/${rhD}/schedules/${schD1.id}`, director, { sceneId: sc1, startAt: '2030-01-04T10:00:00+08:00', endAt: '2030-01-04T11:00:00+08:00' }, 409);
  const adjD = await req('PATCH', `/api/rehearsals/${rhD}/schedules/${schD1.id}`, director, { sceneId: sc1, startAt: '2030-01-04T12:00:00+08:00', endAt: '2030-01-04T13:00:00+08:00' }, 200);
  check('待调整经调整后恢复有效', adjD.schedule.status === 'active' && adjD.schedule.sceneId === sc1);

  console.log('— 日程：取消与可见性 —');
  await J(`/api/rehearsals/${rhD}/schedules/${schD1.id}/cancel`, director, {}, 200);
  await J(`/api/rehearsals/${rhD}/schedules/${schD1.id}/cancel`, director, {}, 400);
  check('取消幂等保护（重复取消 400）', true);
  // RH_E：制造一个仍处于待调整的安排，验证导演可见、演员不可见
  const rhE = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv2, name: '日程排练E' }, 201)).id;
  await J(`/api/rehearsals/${rhE}/cast`, director, { roleId: roleA, actorId: linId }, 201);
  const schE1 = (await J(`/api/rehearsals/${rhE}/schedules`, director, { sceneId: sc2, startAt: '2030-01-05T10:00:00+08:00', endAt: '2030-01-05T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhE}/switch-version`, director, { versionId: pv3 }, 200);
  const dirViewE = await G(`/api/rehearsals/${rhE}/schedules`, director);
  check('导演可见待调整安排', dirViewE.schedules.some((s) => s.id === schE1.id && s.status === 'needs_adjustment'));
  const dirViewEf = await G(`/api/rehearsals/${rhE}/schedules?status=needs_adjustment`, director);
  check('导演可按状态过滤日程', dirViewEf.schedules.length === 1 && dirViewEf.schedules[0].id === schE1.id);
  const dirViewD = await G(`/api/rehearsals/${rhD}/schedules`, director);
  check('导演可见已取消安排', dirViewD.schedules.some((s) => s.id === schD1.id && s.status === 'cancelled'));
  // 演员只看自己当前参与的有效时段
  const linViewA = await G(`/api/rehearsals/${rhA}/schedules`, lin);
  check('演员可见自己参与的有效时段', linViewA.schedules.length > 0 && linViewA.schedules.every((s) => s.status === 'active'));
  check('演员时段含本人角色', linViewA.schedules.every((s) => s.myRoles.some((r) => r.roleId === roleA)));
  const linViewD = await G(`/api/rehearsals/${rhD}/schedules`, lin);
  check('演员看不到已取消时段', linViewD.schedules.length === 0);
  const linViewE = await G(`/api/rehearsals/${rhE}/schedules`, lin);
  check('演员看不到待调整时段', linViewE.schedules.length === 0);
  await G(`/api/rehearsals/${rhC}/schedules`, lin, 403);
  await J(`/api/rehearsals/${rhA}/schedules/${schA1.id}/cancel`, lin, {}, 403);
  await req('PATCH', `/api/rehearsals/${rhA}/schedules/${schA1.id}`, lin, { startAt: '2030-01-01T09:00:00+08:00' }, 403);
  check('未派角演员查看 403；演员不能调整/取消日程', true);

  console.log('— 到场登记：开启冻结名单与缺口 —');
  // 专用剧本 p3：AT1/AT2；角色 RX/RY/RZ；v1 三角在 AT1 均有台词；v2 仅改 RX 文本（场次台词仍在）
  const p3 = await J('/api/plays', director, { title: '登记测试剧' }, 201);
  const at1 = (await J(`/api/plays/${p3.id}/scenes`, director, { code: 'T1', title: '集合场' }, 201)).id;
  const at2 = (await J(`/api/plays/${p3.id}/scenes`, director, { code: 'T2', title: '走位场' }, 201)).id;
  const roleX = (await J(`/api/plays/${p3.id}/roles`, director, { code: 'RX', name: '甲' }, 201)).id;
  const roleY = (await J(`/api/plays/${p3.id}/roles`, director, { code: 'RY', name: '乙' }, 201)).id;
  const roleZ = (await J(`/api/plays/${p3.id}/roles`, director, { code: 'RZ', name: '丙' }, 201)).id;
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at1, roleId: roleX, text: '甲到场一句', seq: 1 }, 201);
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at1, roleId: roleY, text: '乙到场一句', seq: 2 }, 201);
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at1, roleId: roleZ, text: '丙到场一句', seq: 3 }, 201);
  await J(`/api/plays/${p3.id}/lines`, director, { sceneId: at2, roleId: roleX, text: '甲走位一句', seq: 1 }, 201);
  const p3v1 = (await J(`/api/plays/${p3.id}/publish-initial`, director, { note: 'v1' }, 201)).version.id;
  const revX = await J(`/api/plays/${p3.id}/revisions`, director, { title: '改甲词' }, 201);
  await J(`/api/revisions/${revX.id}/items`, director, { action: 'modify', lineId: (await G(`/api/plays/${p3.id}`, director)).lines.find((l) => l.text === '甲到场一句').id, oldText: '甲到场一句', newText: '甲到场一句（改）' }, 201);
  const p3v2 = (await J(`/api/plays/${p3.id}/publish`, director, { revisionIds: [revX.id] }, 201)).newVersion.id;

  // RH_ATT1：RX=林晚、RY=陈默，RZ 未派 -> 开启时名单=[林晚,陈默]，缺口=[丙]
  const rhAtt1 = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '登记排练1' }, 201)).id;
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleY, actorId: chenId }, 201);
  const schAtt1 = (await J(`/api/rehearsals/${rhAtt1}/schedules`, director, { sceneId: at1, startAt: '2031-01-01T10:00:00+08:00', endAt: '2031-01-01T11:00:00+08:00' }, 201)).schedule;
  check('未开启时日程 attendance 为 null', schAtt1.attendance === null);
  // 越权与无效目标
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, lin, {}, 403);
  await J(`/api/rehearsals/${rhAtt1}/schedules/99999/attendance`, director, {}, 404);
  check('演员开启登记 403；日程不存在 404', true);
  const att1 = (await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director, {}, 201)).session;
  check('开启即冻结 UTC 时段与固定版本', att1.startAt === '2031-01-01T02:00:00.000Z' && att1.versionId === p3v1, JSON.stringify({ startAt: att1.startAt, versionId: att1.versionId }));
  check('名单=当时有台词且已派角的演员', att1.roster.length === 2 && att1.roster.every((m) => [linId, chenId].includes(m.actorId)), JSON.stringify(att1.roster));
  check('未派角角色列为缺口且不计应到', att1.gaps.length === 1 && att1.gaps[0].roleId === roleZ && att1.stats.expected === 2);
  check('开启时全员待签到', att1.stats.pending === 2 && att1.roster.every((m) => m.state === 'pending'));
  const attDup = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director, {}, 409);
  check('已有登记的时段不得再开（409 ATTENDANCE_EXISTS）', attDup.error === 'ATTENDANCE_EXISTS');
  // 已取消 / 待调整的时段不得开启（复用前面造好的 schD1=已取消、schE1=待调整）
  await J(`/api/rehearsals/${rhD}/schedules/${schD1.id}/attendance`, director, {}, 400);
  await J(`/api/rehearsals/${rhE}/schedules/${schE1.id}/attendance`, director, {}, 400);
  check('已取消/待调整时段开启登记被拒（400）', true);

  console.log('— 到场登记：签到幂等与名单边界 —');
  const ci1 = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, lin, {}, 201);
  check('名单内演员签到成功', ci1.checkIn.alreadyCheckedIn === false && !!ci1.checkIn.checkedInAt);
  const ci1r = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, lin, {}, 200);
  check('重试返回首次签到结果', ci1r.checkIn.alreadyCheckedIn === true && ci1r.checkIn.checkedInAt === ci1.checkIn.checkedInAt);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, zhou, {}, 403);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, director, {}, 403);
  check('非名单演员/导演签到 403', true);
  await J(`/api/rehearsals/${rhA}/schedules/${schA1.id}/attendance/check-in`, lin, {}, 404);
  check('未开启登记的时段签到 404', true);

  console.log('— 到场登记：改派/换版/调日程不回写 —');
  // 开启后才派角 RZ=周海：后来加入者不能签到；缺口仍按冻结显示
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleZ, actorId: zhouId }, 200);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, zhou, {}, 403);
  await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, zhou, 403);
  check('后来加入者不能签到、也看不了该次登记', true);
  // 改派 RY 陈默->周海：名单不回写——周海仍不能签到，陈默（冻结名单内）仍可签到
  await J(`/api/rehearsals/${rhAtt1}/cast`, director, { roleId: roleY, actorId: zhouId }, 200);
  await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, zhou, {}, 403);
  const ciChen = await J(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance/check-in`, chen, {}, 201);
  check('改派不回写名单：原演员仍在冻结名单可签到', ciChen.checkIn.alreadyCheckedIn === false);
  // 调整日程时间：登记内冻结的 UTC 时段不变
  await req('PATCH', `/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}`, director, { startAt: '2031-01-01T12:00:00+08:00', endAt: '2031-01-01T13:00:00+08:00' }, 200);
  const att1AfterMove = (await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director)).session;
  check('调整日程不回写冻结时段', att1AfterMove.startAt === '2031-01-01T02:00:00.000Z', att1AfterMove.startAt);
  // 换版 v1->v2（文本变化但场次台词仍在）：名单与签到不回写，登记仍冻结在 v1
  await J(`/api/rehearsals/${rhAtt1}/switch-version`, director, { versionId: p3v2 }, 200);
  const att1AfterSwitch = (await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, director)).session;
  check('换版不回写名单与冻结版本', att1AfterSwitch.versionId === p3v1 && att1AfterSwitch.roster.length === 2 && att1AfterSwitch.stats.checkedIn === 2);
  check('缺口保持开启时快照', att1AfterSwitch.gaps.length === 1 && att1AfterSwitch.gaps[0].roleId === roleZ);

  console.log('— 到场登记：关闭记缺席、关闭后拒绝 —');
  // RH_ATT2：RX=林晚（RY/RZ 未派）；林晚不签到 -> 关闭后缺席 1
  const rhAtt2 = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '登记排练2' }, 201)).id;
  await J(`/api/rehearsals/${rhAtt2}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  const schAtt2 = (await J(`/api/rehearsals/${rhAtt2}/schedules`, director, { sceneId: at1, startAt: '2031-01-02T10:00:00+08:00', endAt: '2031-01-02T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance`, director, {}, 201);
  const att2Closed = (await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance/close`, director, {}, 200)).session;
  check('关闭后未签到者记缺席', att2Closed.stats.absent === 1 && att2Closed.roster[0].state === 'absent', JSON.stringify(att2Closed.stats));
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance/check-in`, lin, {}, 409);
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance/close`, director, {}, 400);
  check('关闭后签到 409、再次关闭 400', true);
  // 关闭后取消日程：仅标注取消，原统计保留
  await J(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/cancel`, director, {}, 200);
  const att2AfterCancel = (await G(`/api/rehearsals/${rhAtt2}/schedules/${schAtt2.id}/attendance`, director)).session;
  check('关闭后取消日程仅标注、统计保留', att2AfterCancel.scheduleCancelled === true && att2AfterCancel.status === 'closed' && att2AfterCancel.stats.absent === 1 && att2AfterCancel.stats.counted === true);

  console.log('— 到场登记：开放期取消日程 -> 作废 —');
  // RH_ATT3：RX=林晚；开启并签到后取消日程 -> 作废，痕迹保留但不计出勤
  const rhAtt3 = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '登记排练3' }, 201)).id;
  await J(`/api/rehearsals/${rhAtt3}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  const schAtt3 = (await J(`/api/rehearsals/${rhAtt3}/schedules`, director, { sceneId: at1, startAt: '2031-01-03T10:00:00+08:00', endAt: '2031-01-03T11:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, director, {}, 201);
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance/check-in`, lin, {}, 201);
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/cancel`, director, {}, 200);
  const att3 = (await G(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, director)).session;
  check('开放期取消日程 -> 登记作废', att3.status === 'voided');
  check('作废保留已签到痕迹但不计出勤', att3.roster[0].state === 'checked_in' && !!att3.roster[0].checkedInAt && att3.stats.counted === false && att3.stats.absent === 0, JSON.stringify(att3.stats));
  const ciVoid = await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance/check-in`, lin, {}, 409);
  check('作废后停止签到（409 ATTENDANCE_NOT_OPEN）', ciVoid.error === 'ATTENDANCE_NOT_OPEN');
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance/close`, director, {}, 400);
  check('作废的登记不能关闭', true);
  await J(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, director, {}, 400);
  check('作废（且日程已取消）后该时段不得再次开启登记', true);

  console.log('— 到场登记：可见性与日程摘要 —');
  // 导演日程列表带登记摘要；演员只见本人状态
  const dirScheds1 = await G(`/api/rehearsals/${rhAtt1}/schedules`, director);
  const sumAtt1 = dirScheds1.schedules.find((s) => s.id === schAtt1.id).attendance;
  check('导演日程列表含登记统计摘要', sumAtt1 && sumAtt1.expected === 2 && sumAtt1.checkedIn === 2, JSON.stringify(sumAtt1));
  const linScheds1 = await G(`/api/rehearsals/${rhAtt1}/schedules`, lin);
  const myAtt1 = linScheds1.schedules.find((s) => s.id === schAtt1.id).attendance;
  check('演员日程含本人登记状态', myAtt1 && myAtt1.myState === 'checked_in' && !!myAtt1.checkedInAt, JSON.stringify(myAtt1));
  // 演员详情视图：只有本人记录，没有名单/缺口
  const linAtt1 = (await G(`/api/rehearsals/${rhAtt1}/schedules/${schAtt1.id}/attendance`, lin)).session;
  check('演员只看本人记录（无名单/缺口字段）', linAtt1.my && linAtt1.my.state === 'checked_in' && linAtt1.roster === undefined && linAtt1.gaps === undefined);
  // 作废登记中演员的本人视图
  const linAtt3 = (await G(`/api/rehearsals/${rhAtt3}/schedules/${schAtt3.id}/attendance`, lin)).session;
  check('演员可见本人在作废登记中的签到痕迹', linAtt3.status === 'voided' && linAtt3.my.state === 'checked_in');
  // 未开启登记的日程：演员摘要为 null
  const linSchedsA = await G(`/api/rehearsals/${rhA}/schedules`, lin);
  check('未开启登记时演员摘要为 null', linSchedsA.schedules.every((s) => s.attendance === null));

  console.log('— 演员不可用时段：登记校验、UTC 归一化、与本人有效日程冲突 —');
  // 专用排练 RH_U：p3 v1，RX=林晚（RX 在 AT1/AT2 均有台词）
  const rhU = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '不可用排练1' }, 201)).id;
  await J(`/api/rehearsals/${rhU}/cast`, director, { roleId: roleX, actorId: linId }, 201);

  // 校验：导演不能代登记；无时区 / 结束不晚于开始 / 原因为空均 400
  await J('/api/unavailability', director, { startAt: '2032-01-01T10:00:00Z', endAt: '2032-01-01T11:00:00Z', reason: 'x' }, 403);
  await J('/api/unavailability', lin, { startAt: '2032-01-01T10:00', endAt: '2032-01-01T11:00', reason: 'x' }, 400);
  await J('/api/unavailability', lin, { startAt: '2032-01-01T11:00:00+08:00', endAt: '2032-01-01T10:00:00+08:00', reason: 'x' }, 400);
  await J('/api/unavailability', lin, { startAt: '2032-01-01T10:00:00+08:00', endAt: '2032-01-01T11:00:00+08:00', reason: '   ' }, 400);
  await G('/api/unavailability', null, 401);
  check('不可用登记：导演 403 / 无时区 / 起止颠倒 / 空原因 / 未登录 均被拒', true);

  const schU1 = (await J(`/api/rehearsals/${rhU}/schedules`, director, { sceneId: at1, startAt: '2032-01-01T10:00:00+08:00', endAt: '2032-01-01T11:00:00+08:00' }, 201)).schedule;
  // 与本人当前参与的有效日程重叠 -> 整次拒绝并指出冲突日程
  const uaOv = await J('/api/unavailability', lin, { startAt: '2032-01-01T10:30:00+08:00', endAt: '2032-01-01T11:30:00+08:00', reason: '看病' }, 409);
  check('登记撞本人有效日程 -> UNAVAILABILITY_CONFLICT', uaOv.error === 'UNAVAILABILITY_CONFLICT' && uaOv.details.conflicts[0].schedule.id === schU1.id, JSON.stringify(uaOv));
  const uaActiveAfterFail = (await G('/api/unavailability?status=active', lin)).unavailability;
  check('被拒绝的登记不落库', !uaActiveAfterFail.some((u) => u.startAt === '2032-01-01T02:30:00.000Z'));
  // 跨排练有效日程同样挡（schA1 在 rhA：林晚 2030-01-01 10:00-11:00+08）
  const uaOvReh = await J('/api/unavailability', lin, { startAt: '2030-01-01T10:30:00+08:00', endAt: '2030-01-01T10:45:00+08:00', reason: '跨排练' }, 409);
  check('跨排练的本人有效日程也冲突', uaOvReh.details.conflicts.some((c) => c.schedule.id === schA1.id));
  // 端点相接不算重叠；UTC 归一化（11:00+08:00 = 03:00Z）
  const uaTouch1 = (await J('/api/unavailability', lin, { startAt: '2032-01-01T09:00:00+08:00', endAt: '2032-01-01T10:00:00+08:00', reason: '前置' }, 201)).unavailability;
  const uaTouch2 = (await J('/api/unavailability', lin, { startAt: '2032-01-01T11:00:00+08:00', endAt: '2032-01-01T12:00:00+08:00', reason: '后置' }, 201)).unavailability;
  check('端点相接可登记且按 UTC 保存', uaTouch2.startAt === '2032-01-01T03:00:00.000Z' && uaTouch2.endAt === '2032-01-01T04:00:00.000Z', JSON.stringify(uaTouch2));

  console.log('— 不可用时段：修改 / 撤销 / 越权 —');
  const uaPatchOv = await req('PATCH', `/api/unavailability/${uaTouch2.id}`, lin, { startAt: '2032-01-01T10:30:00+08:00', endAt: '2032-01-01T10:45:00+08:00' }, 409);
  check('修改后撞日程 -> 整次拒绝', uaPatchOv.error === 'UNAVAILABILITY_CONFLICT');
  const uaPatched = (await req('PATCH', `/api/unavailability/${uaTouch2.id}`, lin, { reason: '后置（改原因）' }, 200)).unavailability;
  check('仅修改原因成功且时间不变', uaPatched.reason === '后置（改原因）' && uaPatched.startAt === '2032-01-01T03:00:00.000Z' && !!uaPatched.updatedAt);
  await req('PATCH', '/api/unavailability/99999', lin, { reason: 'x' }, 404);
  await req('PATCH', `/api/unavailability/${uaTouch2.id}`, chen, { reason: 'x' }, 404);
  check('修改不存在 / 他人记录 -> 404', true);
  await J(`/api/unavailability/${uaTouch1.id}/cancel`, lin, {}, 200);
  await J(`/api/unavailability/${uaTouch1.id}/cancel`, lin, {}, 400);
  await req('PATCH', `/api/unavailability/${uaTouch1.id}`, lin, { reason: 'x' }, 400);
  check('撤销成功；重复撤销 400；已撤销不可修改', true);
  await J(`/api/unavailability/${uaTouch2.id}/cancel`, lin, {}, 200);

  console.log('— 不可用时段：已取消 / 待调整日程不参与演员侧检测 —');
  // schU1 已取消 -> 在其时间上登记不可用不再被挡
  await J(`/api/rehearsals/${rhU}/schedules/${schU1.id}/cancel`, director, {}, 200);
  const uaOverCancelled = (await J('/api/unavailability', lin, { startAt: '2032-01-01T10:30:00+08:00', endAt: '2032-01-01T10:45:00+08:00', reason: '日程已取消' }, 201)).unavailability;
  check('已取消日程不参与冲突', uaOverCancelled.id > 0);
  await J(`/api/unavailability/${uaOverCancelled.id}/cancel`, lin, {}, 200);
  // schE1 待调整（rhE 已换 pv3，林晚当前版本在 sc2 无台词）
  const uaOverNeedsAdj = (await J('/api/unavailability', lin, { startAt: '2030-01-05T10:30:00+08:00', endAt: '2030-01-05T10:45:00+08:00', reason: '待调整' }, 201)).unavailability;
  check('待调整日程不参与冲突', uaOverNeedsAdj.id > 0);
  await J(`/api/unavailability/${uaOverNeedsAdj.id}/cancel`, lin, {}, 200);

  console.log('— 导演操作：安排/调整撞演员不可用整次不生效 —');
  const rhU2 = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '不可用排练2' }, 201)).id;
  await J(`/api/rehearsals/${rhU2}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  const uaU2 = (await J('/api/unavailability', lin, { startAt: '2032-03-01T10:00:00+08:00', endAt: '2032-03-01T12:00:00+08:00', reason: '体检' }, 201)).unavailability;
  const schedUaOv = await J(`/api/rehearsals/${rhU2}/schedules`, director, { sceneId: at1, startAt: '2032-03-01T10:30:00+08:00', endAt: '2032-03-01T11:30:00+08:00' }, 409);
  check('安排撞不可用 -> UNAVAILABILITY_CONFLICT 且返回演员/日程/不可用时段',
    schedUaOv.error === 'UNAVAILABILITY_CONFLICT'
      && schedUaOv.details.conflicts[0].actorId === linId
      && schedUaOv.details.conflicts[0].schedule.id === null
      && schedUaOv.details.conflicts[0].unavailability.id === uaU2.id
      && schedUaOv.details.conflicts[0].unavailability.reason === '体检',
    JSON.stringify(schedUaOv));
  check('被拒安排不落库', (await G(`/api/rehearsals/${rhU2}/schedules`, director)).schedules.length === 0);
  // 端点相接可安排
  const schU2 = (await J(`/api/rehearsals/${rhU2}/schedules`, director, { sceneId: at1, startAt: '2032-03-01T12:00:00+08:00', endAt: '2032-03-01T13:00:00+08:00' }, 201)).schedule;
  const patchUaOv = await req('PATCH', `/api/rehearsals/${rhU2}/schedules/${schU2.id}`, director, { startAt: '2032-03-01T11:00:00+08:00', endAt: '2032-03-01T11:30:00+08:00' }, 409);
  check('调整撞不可用 -> 整次拒绝', patchUaOv.error === 'UNAVAILABILITY_CONFLICT');
  const schU2After = (await G(`/api/rehearsals/${rhU2}/schedules`, director)).schedules[0];
  check('被拒调整不改写原时段', schU2After.startAt === '2032-03-01T04:00:00.000Z', schU2After.startAt);
  // 有效日程的参与者序列化带 unavailabilityOverlaps 字段（相接不重叠 => 空）
  check('导演日程参与者带不可用相撞信息字段', Array.isArray(schU2After.participants[0].unavailabilityOverlaps) && schU2After.participants[0].unavailabilityOverlaps.length === 0);

  console.log('— 导演操作：派角/改派撞不可用整次回滚；日程互撞优先 409 SCHEDULE_CONFLICT —');
  // RH_V 暂不派角：S1(AT1) 与 S2(AT2) 互相重叠；林晚先登记不可用
  const rhV = (await J(`/api/plays/${p3.id}/rehearsals`, director, { versionId: p3v1, name: '不可用排练3' }, 201)).id;
  const sV1 = (await J(`/api/rehearsals/${rhV}/schedules`, director, { sceneId: at1, startAt: '2032-04-01T10:00:00+08:00', endAt: '2032-04-01T12:00:00+08:00' }, 201)).schedule;
  await J(`/api/rehearsals/${rhV}/schedules`, director, { sceneId: at2, startAt: '2032-04-01T11:00:00+08:00', endAt: '2032-04-01T13:00:00+08:00' }, 201);
  await J('/api/unavailability', lin, { startAt: '2032-04-01T10:30:00+08:00', endAt: '2032-04-01T10:45:00+08:00', reason: '面试' }, 201);
  // 林晚不是参与者时可自由安排；此时 RX 在两个场次都有台词，派角将同时撞日程与不可用
  const castPrecedence = await J(`/api/rehearsals/${rhV}/cast`, director, { roleId: roleX, actorId: linId }, 409);
  check('日程互撞与不可用同时存在时优先 SCHEDULE_CONFLICT', castPrecedence.error === 'SCHEDULE_CONFLICT');
  // 解除日程互撞（S2 改为端点相接），参与者仍为空，调整不受不可用影响
  const sV2Id = (await G(`/api/rehearsals/${rhV}/schedules`, director)).schedules.find((s) => s.sceneId === at2).id;
  await req('PATCH', `/api/rehearsals/${rhV}/schedules/${sV2Id}`, director, { startAt: '2032-04-01T12:00:00+08:00', endAt: '2032-04-01T13:00:00+08:00' }, 200);
  const castUa = await J(`/api/rehearsals/${rhV}/cast`, director, { roleId: roleX, actorId: linId }, 409);
  check('派角撞不可用 -> UNAVAILABILITY_CONFLICT 并回滚',
    castUa.error === 'UNAVAILABILITY_CONFLICT'
      && castUa.details.conflicts.some((c) => c.actorId === linId && c.schedule.id === sV1.id),
    JSON.stringify(castUa));
  check('被拒派角不落库', (await G(`/api/rehearsals/${rhV}`, director)).cast.length === 0);
  // 演员撤销不可用后派角成功
  const uaVId = (await G('/api/unavailability?status=active', lin)).unavailability.find((u) => u.reason === '面试').id;
  await J(`/api/unavailability/${uaVId}/cancel`, lin, {}, 200);
  await J(`/api/rehearsals/${rhV}/cast`, director, { roleId: roleX, actorId: linId }, 201);
  check('撤销不可用后派角成功', true);

  console.log('— 导演操作：显式换版撞不可用整次回滚 —');
  // RH_W 固定 p2 v1：乙(陈默) 在 v1 的 sc1 无台词；v2 新增乙在 sc1 的台词
  const rhW = (await J(`/api/plays/${p2.id}/rehearsals`, director, { versionId: pv1, name: '不可用排练4' }, 201)).id;
  await J(`/api/rehearsals/${rhW}/cast`, director, { roleId: roleB, actorId: chenId }, 201);
  const sW1 = (await J(`/api/rehearsals/${rhW}/schedules`, director, { sceneId: sc1, startAt: '2032-05-01T10:00:00+08:00', endAt: '2032-05-01T11:00:00+08:00' }, 201)).schedule;
  check('v1 中乙在 sc1 无台词：参与者为空', sW1.participants.length === 0);
  await J('/api/unavailability', chen, { startAt: '2032-05-01T10:30:00+08:00', endAt: '2032-05-01T10:45:00+08:00', reason: '家中有事' }, 201);
  const swUa = await J(`/api/rehearsals/${rhW}/switch-version`, director, { versionId: pv2 }, 409);
  check('换版使陈默成为该时段参与者且撞其不可用 -> 整次拒绝',
    swUa.error === 'UNAVAILABILITY_CONFLICT' && swUa.details.conflicts.some((c) => c.actorId === chenId && c.schedule.id === sW1.id),
    JSON.stringify(swUa));
  check('失败换版不改变固定版本', (await G(`/api/rehearsals/${rhW}`, director)).rehearsal.versionId === pv1);
  const uaWId = (await G('/api/unavailability?status=active', chen)).unavailability.find((u) => u.reason === '家中有事').id;
  await J(`/api/unavailability/${uaWId}/cancel`, chen, {}, 200);
  const swOkU = await J(`/api/rehearsals/${rhW}/switch-version`, director, { versionId: pv2 }, 200);
  check('撤销不可用后换版成功', swOkU.rehearsal.versionId === pv2);

  console.log('— 不可用变化不改写已开启登记；可见性 —');
  // schU2 有效且林晚在名单：开启签到，再登记/调整相邻不可用不影响名单与签到
  const attU = (await J(`/api/rehearsals/${rhU2}/schedules/${schU2.id}/attendance`, director, {}, 201)).session;
  check('不可用存在时仍可对有效时段开启登记（名单冻结）', attU.roster.length === 1 && attU.roster[0].actorId === linId);
  await J(`/api/rehearsals/${rhU2}/schedules/${schU2.id}/attendance/check-in`, lin, {}, 201);
  await J('/api/unavailability', lin, { startAt: '2032-03-01T13:00:00+08:00', endAt: '2032-03-01T14:00:00+08:00', reason: '签到后登记' }, 201);
  const attU2 = (await G(`/api/rehearsals/${rhU2}/schedules/${schU2.id}/attendance`, director)).session;
  check('不可用变化不改写名单与签到', attU2.roster.length === 1 && attU2.stats.checkedIn === 1);
  // 可见性：导演按演员查（可过滤状态）；演员只看本人
  const dirUa = await G(`/api/unavailability?actorId=${linId}`, director);
  check('导演可查看演员不可用记录', dirUa.unavailability.every((u) => u.actorId === linId) && dirUa.unavailability.length >= 2);
  const dirUaActive = await G(`/api/unavailability?actorId=${linId}&status=active`, director);
  check('导演可按状态过滤', dirUaActive.unavailability.every((u) => u.status === 'active'));
  await G('/api/unavailability', director, 400);
  await G('/api/unavailability?actorId=99999', director, 404);
  const linScoped = await G(`/api/unavailability?actorId=${chenId}`, lin);
  check('演员带 actorId 仍只返回本人记录', linScoped.unavailability.every((u) => u.actorId === linId));

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常中断:', e.message);
  process.exit(1);
});
