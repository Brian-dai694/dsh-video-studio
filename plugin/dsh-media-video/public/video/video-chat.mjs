// 视频编辑器对话面板：消息映射、工具卡片、输入区与审批状态。
//
// 规则（与图片侧一致，不允许出现第二套风格）：
// 1) 任何消息都不显示原始 JSON；解析不了就退回一句话摘要。
// 2) 工具卡片必须带身份：trackId / clipId / 起止微秒；点卡片定位到时间线片段并高亮。
// 3) 审批只显示状态 + 「打开原生会话」，拿不到入口就不渲染按钮，绝不造假按钮。
// 4) 输入区：多行、Enter 发送、Shift+Enter 换行；发送中禁用；失败只允许手动重试一次，且参数不变。

const KIND_LABEL = {
  user: '你',
  assistant: '助手',
  tool: '工具调用',
  toolResult: '工具结果',
  approval: '审批',
  error: '错误',
  system: '系统',
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** 微秒 → mm:ss.mmm；非法值给「—」，不猜。 */
export function formatMicros(micros) {
  if (micros === null || micros === undefined || micros === '') return '—';
  const value = Number(micros);
  if (!Number.isFinite(value) || value < 0) return '—';
  const ms = value / 1000;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

const shortId = value => (typeof value === 'string' && value.length > 8 ? `${value.slice(0, 6)}…` : String(value ?? '—'));

/** 极简 Markdown：段落、列表、代码块、行内代码、粗体、链接。全部先转义，绝不 innerHTML 拼原文。 */
export function renderMarkdownLite(text) {
  const source = escapeHtml(text);
  const blocks = [];
  const withBlocks = source.replace(/```([\s\S]*?)```/g, (_, code) => `\u0000${blocks.push(code.replace(/^\w*\n/, '').replace(/\n$/, '')) - 1}\u0000`);
  const inline = chunk => chunk
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const html = withBlocks.split(/\n{2,}/).map(paragraph => {
    const lines = paragraph.split('\n');
    if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
      return `<ul>${lines.map(line => `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => `<pre><code>${blocks[Number(index)]}</code></pre>`);
}

/** 工具调用的一句话摘要（无原始 JSON）。 */
export function summariseTool(tool) {
  if (!tool || typeof tool !== 'object') return '工具调用';
  const parts = [];
  if (tool.name) parts.push(String(tool.name));
  if (tool.trackId) parts.push(`轨道 ${shortId(tool.trackId)}`);
  if (tool.clipId) parts.push(`片段 ${shortId(tool.clipId)}`);
  if (tool.startMicros !== undefined || tool.endMicros !== undefined) {
    parts.push(`${formatMicros(tool.startMicros)}–${formatMicros(tool.endMicros)}`);
  }
  return parts.join(' · ');
}

/** 读一个"人话"消息文本：优先 text，其次按 kind 组装摘要，绝不放 JSON。 */
function messageText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  if (message.kind === 'tool') return summariseTool(message.tool);
  if (message.kind === 'toolResult') return message.ok === false ? `执行失败：${message.error?.message || '未知原因'}` : '执行完成';
  return '';
}

export function mountChat({ root, onLocate, onOpenSession, onSend, onRetry, initialMessages = [], emptyHint = '和 DSH 说一句，让它改这条时间线。' }) {
  const list = root.querySelector('[data-chat-list]');
  const composer = root.querySelector('[data-chat-input]');
  const sendButton = root.querySelector('[data-chat-send]');
  const attachButton = root.querySelector('[data-chat-attach]');
  const attachInput = root.querySelector('[data-chat-file]');
  const attachmentRow = root.querySelector('[data-chat-attachments]');
  const errorBar = root.querySelector('[data-chat-error]');
  const state = { messages: [], sending: false, retryUsed: false, attachments: [], lastPayload: null };

  const skeleton = document.createElement('div');
  skeleton.className = 'chat-skeleton';
  skeleton.innerHTML = '<span></span><span></span><span></span>';

  function showError(text) {
    if (!text) { errorBar.hidden = true; errorBar.textContent = ''; return; }
    errorBar.hidden = false;
    errorBar.textContent = text;
  }

  function scrollToEnd() {
    list.scrollTop = list.scrollHeight;
  }

  function renderEmpty() {
    if (state.messages.length) return;
    const node = document.createElement('p');
    node.className = 'chat-empty';
    node.textContent = emptyHint;
    list.appendChild(node);
  }

  function toolCard(tool, badge) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tool-card';
    card.setAttribute('data-tool-card', '');
    const head = document.createElement('div');
    head.className = 'tool-card-head';
    const title = document.createElement('strong');
    title.textContent = summariseTool(tool);
    head.appendChild(title);
    if (badge) {
      const chip = document.createElement('span');
      chip.className = `tool-badge badge-${badge}`;
      // unknown 必须显眼且不能说成失败：结果未知 = 不要重放。
      chip.textContent = badge === 'unknown' ? '结果未知 · 不要重放' : badge === 'pending' ? '执行中' : badge === 'rejected' ? '已拒绝' : '已执行';
      chip.setAttribute('data-badge', badge);
      head.appendChild(chip);
    }
    card.appendChild(head);
    const meta = document.createElement('small');
    meta.textContent = tool.trackId || tool.clipId ? '点击定位到时间线片段' : '无可定位对象';
    card.appendChild(meta);
    if (tool.trackId || tool.clipId) {
      card.addEventListener('click', () => { onLocate?.({ trackId: tool.trackId, clipId: tool.clipId }); });
    } else {
      card.disabled = true;
      card.classList.add('is-flat');
    }
    return card;
  }

  function approvalCard(message) {
    const box = document.createElement('div');
    box.className = 'approval-card';
    const status = document.createElement('p');
    status.className = 'approval-state';
    status.textContent = message.status === 'pending' ? '等待本人在原生会话确认' : message.status === 'rejected' ? '已拒绝' : '不可用';
    box.appendChild(status);
    if (message.canOpenSession && typeof onOpenSession === 'function') {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'secondary-btn';
      open.textContent = '打开原生会话';
      open.addEventListener('click', () => onOpenSession());
      box.appendChild(open);
    } else {
      const note = document.createElement('span');
      note.className = 'approval-note';
      note.textContent = '本页不代答审批';
      box.appendChild(note);
    }
    return box;
  }

  function render(message) {
    const item = document.createElement('article');
    item.className = `chat-message chat-${message.kind || 'assistant'}`;
    if (message.kind === 'user' || message.kind === 'assistant' || message.kind === 'system') {
      const who = document.createElement('span');
      who.className = 'chat-who';
      who.textContent = KIND_LABEL[message.kind] || '';
      const body = document.createElement('div');
      body.className = 'chat-body';
      body.innerHTML = renderMarkdownLite(message.text || '');
      item.append(who, body);
    } else if (message.kind === 'tool') {
      item.appendChild(toolCard(message.tool || {}, message.badge || null));
    } else if (message.kind === 'approval') {
      item.appendChild(approvalCard(message));
    } else if (message.kind === 'error') {
      const body = document.createElement('p');
      body.className = 'chat-error-text';
      body.textContent = message.text || '出错了';
      item.appendChild(body);
    } else {
      const body = document.createElement('p');
      body.className = 'chat-result';
      body.textContent = messageText(message);
      item.appendChild(body);
    }
    if (message.attachments?.length) {
      const row = document.createElement('div');
      row.className = 'chat-attachment-chips';
      for (const name of message.attachments) {
        const chip = document.createElement('span');
        chip.textContent = name;
        row.appendChild(chip);
      }
      item.appendChild(row);
    }
    list.appendChild(item);
    scrollToEnd();
  }

  function append(message) {
    state.messages.push(message);
    const empty = list.querySelector('.chat-empty');
    if (empty) empty.remove();
    render(message);
  }

  function setSending(value) {
    state.sending = value;
    composer.disabled = value;
    sendButton.disabled = value || !composer.value.trim();
    sendButton.textContent = value ? '发送中…' : '发送';
  }

  function refreshSendState() {
    sendButton.disabled = state.sending || !composer.value.trim();
  }

  function renderAttachments() {
    attachmentRow.innerHTML = '';
    attachmentRow.hidden = state.attachments.length === 0;
    for (const [index, file] of state.attachments.entries()) {
      const chip = document.createElement('span');
      chip.className = 'chat-attachment';
      chip.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除附件 ${file.name}`);
      remove.addEventListener('click', () => { state.attachments.splice(index, 1); renderAttachments(); });
      chip.appendChild(remove);
      attachmentRow.appendChild(chip);
    }
  }

  async function send(payload) {
    showError('');
    state.lastPayload = payload;
    setSending(true);
    append({ kind: 'user', text: payload.text || '', attachments: payload.attachments?.map(file => file.name) || [] });
    try {
      await onSend?.(payload);
      setSending(false);
      refreshSendState();
    } catch (error) {
      setSending(false);
      refreshSendState();
      showError(error?.message || '发送失败');
      append({ kind: 'error', text: `发送失败：${error?.message || '未知原因'}` });
      if (!state.retryUsed) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'secondary-btn chat-retry';
        retry.textContent = '重试一次（参数不变）';
        retry.addEventListener('click', async () => {
          state.retryUsed = true;
          retry.remove();
          await send(state.lastPayload);
        });
        list.appendChild(retry);
        scrollToEnd();
      }
    }
  }

  function submit() {
    const text = composer.value.trim();
    if (!text || state.sending) return;
    const payload = { text, attachments: [...state.attachments], commandId: crypto.randomUUID() };
    composer.value = '';
    state.attachments = [];
    renderAttachments();
    refreshSendState();
    void send(payload);
  }

  composer.addEventListener('input', refreshSendState);
  composer.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  });
  sendButton.addEventListener('click', submit);
  attachButton.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', () => {
    for (const file of attachInput.files || []) state.attachments.push(file);
    attachInput.value = '';
    renderAttachments();
  });

  // 首帧骨架 → 第一条消息到达后替换；没有消息就落到空状态。
  list.appendChild(skeleton);
  setTimeout(() => {
    skeleton.remove();
    renderEmpty();
    for (const message of initialMessages) append(message);
  }, 320);

  return {
    append,
    showError,
    get messages() { return [...state.messages]; },
    setSending,
  };
}
