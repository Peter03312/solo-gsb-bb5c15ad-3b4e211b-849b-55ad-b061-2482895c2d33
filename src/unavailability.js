const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 演员不可用时段。
 *
 * 核心规则：
 *   - 演员可登记 / 修改 / 撤销本人的不可用时段：提交带时区的起止时间与原因；
 *     服务端归一化为 UTC 存储；结束必须晚于开始；端点相接（半开区间 [start, end)）不算重叠。
 *   - 登记 / 修改时，若与本人“当前参与的有效（active）排练日程”重叠，整次拒绝，
 *     返回 409 UNAVAILABILITY_CONFLICT，details.conflicts 指出相撞的日程。
 *   - 导演安排 / 调整时段、派角 / 改派、显式换版时，由 schedules.js 在其事务内
 *     调用 assertNoUnavailabilityConflicts：候选时段的受影响演员若有 active 不可用
 *     时段相撞，则整次操作不生效（已取消与待调整日程不参与；演员不可用记录撤销后同样不参与）。
 *   - 已开启的到场登记名单与签到不随不可用时段变化而改写（本模块不触碰 attendance_*）。
 *
 * 为避免与 schedules.js 循环依赖，参与者（某时段当前版本有台词且已派角的演员）
 * 的计算在本模块内独立实现一份（逻辑与 schedules.participantDetails 一致）。
 */

const router = express.Router();
router.use(authRequired);

/** 带时区的 ISO 8601：2026-10-03T14:00:00+08:00 或 ...Z；归一化为 UTC */
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function parseTzDateTime(value, field) {
  const s = String(value ?? '').trim();
  if (!ISO_WITH_TZ.test(s)) {
    throw badRequest(`${field} 必须是带时区的 ISO 8601 时间（如 2026-10-03T14:00:00+08:00 或 2026-10-03T06:00:00Z）`);
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw badRequest(`${field} 不是有效的日期时间`);
  return new Date(ms).toISOString();
}

/** 半开区间重叠：端点相接（a.end == b.start）不算重叠 */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * 时段参与者（与 schedules.participantDetails 同口径，独立实现避免循环依赖）：
 * 该排练当前固定版本中本场有台词的角色里，已派角的演员。
 */
function participantActorIds(rehearsalId, versionId, sceneId) {
  const roleIds = db
    .prepare('SELECT DISTINCT role_id FROM version_lines WHERE version_id = ? AND scene_id = ?')
    .all(versionId, sceneId)
    .map((r) => r.role_id);
  if (!roleIds.length) return [];
  const placeholders = roleIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT actor_id FROM rehearsal_cast
        WHERE rehearsal_id = ? AND role_id IN (${placeholders})`
    )
    .all(rehearsalId, ...roleIds);
  return rows.map((r) => r.actor_id);
}

// ---- 序列化 ----
function serializeUnavailability(u) {
  return {
    id: u.id,
    actorId: u.actor_id,
    startAt: u.start_at,
    endAt: u.end_at,
    reason: u.reason,
    status: u.status,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    cancelledAt: u.cancelled_at,
  };
}

function getOwnedOrThrow(id, actorId) {
  const u = db.prepare('SELECT * FROM actor_unavailability WHERE id = ?').get(id);
  if (!u || u.actor_id !== actorId) throw notFound('不可用时段不存在');
  return u;
}

/**
 * 演员视角：不可用时段与本人当前参与的有效日程的相撞列表。
 * 仅比较 status=active 的日程（已取消 / 待调整不参与），端点相接不算重叠。
 */
function findActorScheduleOverlaps(actorId, startAt, endAt) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  const schedules = db
    .prepare(
      `SELECT s.*, r.version_id, r.name AS rehearsal_name
         FROM rehearsal_schedules s
         JOIN rehearsals r ON r.id = s.rehearsal_id
        WHERE s.status = 'active'`
    )
    .all();
  const out = [];
  for (const s of schedules) {
    if (!overlaps(startMs, endMs, Date.parse(s.start_at), Date.parse(s.end_at))) continue;
    if (!participantActorIds(s.rehearsal_id, s.version_id, s.scene_id).includes(actorId)) continue;
    out.push(scheduleRef(s));
  }
  return out;
}

/**
 * 导演操作视角：候选时段（schedules.js 构造：含 actorIds/startMs/endMs/场景/排练）
 * 与受影响演员的 active 不可用记录相撞列表，按“演员 × 时段 × 不可用记录”去重。
 * 已取消 / 待调整日程不会进入候选，无需在此再判。
 */
function findUnavailabilityConflicts(candidates) {
  const conflicts = [];
  const seen = new Set();
  const actorCache = new Map();
  const unavailOf = (actorId) => {
    if (!actorCache.has(actorId)) {
      actorCache.set(
        actorId,
        db
          .prepare("SELECT * FROM actor_unavailability WHERE actor_id = ? AND status = 'active'")
          .all(actorId)
      );
    }
    return actorCache.get(actorId);
  };
  const actorName = (actorId) => {
    const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(actorId);
    return u?.display_name ?? `#${actorId}`;
  };
  for (const cand of candidates) {
    for (const actorId of cand.actorIds || []) {
      for (const ua of unavailOf(actorId)) {
        if (!overlaps(cand.startMs, cand.endMs, Date.parse(ua.start_at), Date.parse(ua.end_at))) continue;
        const candKey = cand.scheduleId != null ? `sched:${cand.scheduleId}` : `new:${cand.rehearsalId}:${cand.sceneId}:${cand.startAt}:${cand.endAt}`;
        const dedupe = `${actorId}|${candKey}|${ua.id}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        conflicts.push({
          actorId,
          actorName: actorName(actorId),
          schedule: scheduleRef(cand),
          unavailability: unavailabilityRef(ua),
        });
      }
    }
  }
  return conflicts;
}

function assertNoUnavailabilityConflicts(candidates, message) {
  const conflicts = findUnavailabilityConflicts(candidates);
  if (conflicts.length) throw conflict('UNAVAILABILITY_CONFLICT', message, { conflicts });
}

function sceneTitleOf(sceneId) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  return scene ? `${scene.code} ${scene.title}` : null;
}

/** 日程引用（与 SCHEDULE_CONFLICT 的 schedule/overlapsWith 字段口径一致） */
function scheduleRef(x) {
  const sceneId = x.sceneId ?? x.scene_id;
  return {
    id: x.scheduleId ?? x.id ?? null,
    rehearsalId: x.rehearsalId ?? x.rehearsal_id,
    rehearsalName: x.rehearsalName ?? x.rehearsal_name ?? null,
    sceneId,
    sceneTitle: sceneTitleOf(sceneId),
    startAt: x.startAt ?? x.start_at,
    endAt: x.endAt ?? x.end_at,
  };
}

function unavailabilityRef(u) {
  return {
    id: u.id,
    actorId: u.actor_id,
    startAt: u.start_at,
    endAt: u.end_at,
    reason: u.reason,
  };
}

// ---- 演员：登记不可用时段 ----
router.post(
  '/unavailability',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员可登记不可用时段');
    const startAt = parseTzDateTime(req.body?.startAt, 'startAt');
    const endAt = parseTzDateTime(req.body?.endAt, 'endAt');
    if (Date.parse(endAt) <= Date.parse(startAt)) throw badRequest('结束时间必须晚于开始时间');
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw badRequest('reason 必填（不可用原因）');

    const conflicts = findActorScheduleOverlaps(req.user.id, startAt, endAt);
    if (conflicts.length) {
      throw conflict(
        'UNAVAILABILITY_CONFLICT',
        '该不可用时段与你当前参与的有效排练日程重叠，本次登记未生效',
        { conflicts: conflicts.map((s) => ({ schedule: s })) }
      );
    }
    const id = transaction(() =>
      db
        .prepare('INSERT INTO actor_unavailability (actor_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)')
        .run(req.user.id, startAt, endAt, reason).lastInsertRowid
    );
    res.status(201).json({ unavailability: serializeUnavailability(getOwnedOrThrow(id, req.user.id)) });
  })
);

// ---- 列表：演员看本人全部记录（?status=active|cancelled 可过滤）；导演可按演员查看 ----
router.get(
  '/unavailability',
  wrap((req, res) => {
    let actorId;
    if (req.user.role === 'director') {
      actorId = Number(req.query.actorId);
      if (!Number.isInteger(actorId)) throw badRequest('导演查询须指定 actorId');
      const actor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(actorId);
      if (!actor) throw notFound('演员不存在');
    } else {
      actorId = req.user.id;
    }
    let rows = db
      .prepare('SELECT * FROM actor_unavailability WHERE actor_id = ? ORDER BY start_at DESC, id DESC')
      .all(actorId);
    const status = req.query.status;
    if (status != null && status !== '') {
      if (!['active', 'cancelled'].includes(status)) throw badRequest('status 只能是 active / cancelled');
      rows = rows.filter((x) => x.status === status);
    }
    res.json({ unavailability: rows.map(serializeUnavailability) });
  })
);

// ---- 演员：修改本人不可用时段（部分更新时间/原因；撤销记录不可改） ----
router.patch(
  '/unavailability/:id',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员可修改本人的不可用时段');
    const u = getOwnedOrThrow(req.params.id, req.user.id);
    if (u.status === 'cancelled') throw badRequest('已撤销的不可用时段不能修改，请重新登记');

    const startAt =
      req.body?.startAt !== undefined ? parseTzDateTime(req.body.startAt, 'startAt') : u.start_at;
    const endAt = req.body?.endAt !== undefined ? parseTzDateTime(req.body.endAt, 'endAt') : u.end_at;
    if (Date.parse(endAt) <= Date.parse(startAt)) throw badRequest('结束时间必须晚于开始时间');
    const reason = req.body?.reason !== undefined ? String(req.body.reason).trim() : u.reason;
    if (!reason) throw badRequest('reason 不能为空');

    const conflicts = findActorScheduleOverlaps(req.user.id, startAt, endAt);
    if (conflicts.length) {
      throw conflict(
        'UNAVAILABILITY_CONFLICT',
        '修改后的不可用时段与你当前参与的有效排练日程重叠，本次修改未生效',
        { conflicts: conflicts.map((s) => ({ schedule: s })) }
      );
    }
    transaction(() => {
      db.prepare(
        "UPDATE actor_unavailability SET start_at = ?, end_at = ?, reason = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(startAt, endAt, reason, u.id);
    });
    res.json({ unavailability: serializeUnavailability(getOwnedOrThrow(u.id, req.user.id)) });
  })
);

// ---- 演员：撤销本人不可用时段（软删除，记录保留；重复撤销 400） ----
router.post(
  '/unavailability/:id/cancel',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员可撤销本人的不可用时段');
    const u = getOwnedOrThrow(req.params.id, req.user.id);
    if (u.status === 'cancelled') throw badRequest('该不可用时段已撤销');
    transaction(() => {
      db.prepare(
        "UPDATE actor_unavailability SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?"
      ).run(u.id);
    });
    res.json({ ok: true, unavailability: serializeUnavailability(getOwnedOrThrow(u.id, req.user.id)) });
  })
);

module.exports = {
  router,
  assertNoUnavailabilityConflicts,
};
