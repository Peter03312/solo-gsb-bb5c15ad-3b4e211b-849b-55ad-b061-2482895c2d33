/* 演员：我的不可用时段（登记 / 修改 / 撤销） */
const UNAVAIL_STATUS_LABEL = { active: '有效', cancelled: '已撤销' };
const UNAVAIL_STATUS_CLASS = { active: 'done', cancelled: 'abandoned' };

/** 409 UNAVAILABILITY_CONFLICT：把相撞日程拼成可读提示 */
function unavailErr(err) {
  const conflicts = err?.data?.details?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length) {
    const lines = conflicts.map((c) => {
      if (c.schedule) {
        return `《${esc(c.schedule.rehearsalName ?? '')}》${esc(c.schedule.sceneTitle ?? '')} ${fmtTime(c.schedule.startAt)}–${fmtTime(c.schedule.endAt)}`;
      }
      if (c.unavailability) {
        return `${esc(c.actorName)} 不可用 ${fmtTime(c.unavailability.startAt)}–${fmtTime(c.unavailability.endAt)}（${esc(c.unavailability.reason)}）`;
      }
      return '';
    });
    return `${err.message}：${lines.filter(Boolean).join('；')}`;
  }
  return err.message;
}

async function loadUnavailabilityCard() {
  const card = el('<div class="card"><h2>我的不可用时段</h2><div class="unavailRows muted">加载中…</div></div>');
  const rowsBox = card.querySelector('.unavailRows');

  const form = el(`
    <form class="flex unavailForm" style="margin-top:8px">
      <input type="hidden" name="id" />
      <input type="datetime-local" name="startAt" required style="max-width:210px" title="开始（本地时区）" />
      <input type="datetime-local" name="endAt" required style="max-width:210px" title="结束（本地时区）" />
      <input name="reason" placeholder="原因（必填）" required style="min-width:180px" />
      <button class="btn small primary unavailSubmit" type="submit">登记</button>
      <button class="btn small unavailCancelEdit hidden" type="button">放弃修改</button>
    </form>
    <div class="muted">按本地时间选择，提交时自动携带时区并按 UTC 保存；结束须晚于开始，端点相接不算冲突。
      登记或修改若与你当前参与的<strong>有效排练日程</strong>重叠，会被整次拒绝。</div>`);
  card.appendChild(form);
  const submitBtn = form.querySelector('.unavailSubmit');
  const cancelEditBtn = form.querySelector('.unavailCancelEdit');

  const resetForm = () => {
    form.reset();
    form.querySelector('[name=id]').value = '';
    submitBtn.textContent = '登记';
    cancelEditBtn.classList.add('hidden');
  };
  cancelEditBtn.addEventListener('click', resetForm);

  async function reload() {
    let list;
    try {
      ({ unavailability: list } = await api('GET', '/api/unavailability'));
    } catch (err) {
      rowsBox.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
      return;
    }
    if (!list.length) {
      rowsBox.innerHTML = '<span class="muted">暂无不可用登记</span>';
      return;
    }
    rowsBox.innerHTML = `<table>
      <tr><th>状态</th><th>开始（本地）</th><th>结束（本地）</th><th>原因</th><th>操作</th></tr>
      ${list.map((u) => `<tr>
        <td><span class="badge ${UNAVAIL_STATUS_CLASS[u.status]}">${UNAVAIL_STATUS_LABEL[u.status]}</span></td>
        <td>${fmtTime(u.startAt)}</td>
        <td>${fmtTime(u.endAt)}</td>
        <td>${esc(u.reason)}</td>
        <td>${u.status === 'active'
          ? `<button class="btn small editUnavail" data-id="${u.id}">修改</button>
             <button class="btn small danger cancelUnavail" data-id="${u.id}">撤销</button>`
          : '—'}</td>
      </tr>`).join('')}
    </table>`;

    rowsBox.querySelectorAll('.cancelUnavail').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('确定撤销该不可用时段？撤销后记录保留，但不再参与排期冲突检测。')) return;
        try {
          await api('POST', `/api/unavailability/${b.dataset.id}/cancel`);
          toast('已撤销');
          reload();
        } catch (err) { toast(err.message, true); }
      })
    );
    rowsBox.querySelectorAll('.editUnavail').forEach((b) =>
      b.addEventListener('click', () => {
        const u = list.find((x) => String(x.id) === b.dataset.id);
        if (!u) return;
        const toLocalInput = (iso) => {
          const d = new Date(iso);
          const pad = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };
        form.querySelector('[name=id]').value = u.id;
        form.querySelector('[name=startAt]').value = toLocalInput(u.startAt);
        form.querySelector('[name=endAt]').value = toLocalInput(u.endAt);
        form.querySelector('[name=reason]').value = u.reason;
        submitBtn.textContent = '保存修改';
        cancelEditBtn.classList.remove('hidden');
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      startAt: new Date(fd.get('startAt')).toISOString(),
      endAt: new Date(fd.get('endAt')).toISOString(),
      reason: fd.get('reason'),
    };
    const id = fd.get('id');
    try {
      if (id) {
        await api('PATCH', `/api/unavailability/${id}`, body);
        toast('不可用时段已修改');
      } else {
        await api('POST', '/api/unavailability', body);
        toast('不可用时段已登记');
      }
      resetForm();
      reload();
    } catch (err) { toast(unavailErr(err), true); }
  });

  await reload();
  return card;
}
