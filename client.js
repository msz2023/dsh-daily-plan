/**
 * Daily plan: browser half.
 *
 * Registers a first-class left-sidebar panel ("每日任务") whose main-panel cell
 * is today's plan grouped by the time each task is due, plus a full-screen
 * focus timer. All task data comes from the host API under /daily-plan-api/*.
 */

window.__ModuleLoader__.load({
  id: 'dsh-daily-plan',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    // Portals keep the full-screen timer outside the panel's clipped column.
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const PANEL_ID = 'daily-plan'
    const NS = 'dailyPlan'
    const PREF_KEY = 'dsh.daily-plan'
    const MINUTE = 60
    const FOCUS_PRESETS = [15, 25, 45, 60]
    const REPEAT_VALUES = ['none', 'daily', 'weekdays', 'weekly', 'monthly']
    const REMIND_KEY = 'dsh.daily-plan.remind'
    const IS_ZH = String(navigator.language || '').toLowerCase().startsWith('zh')

    // The host can own an orphaned route after a reload; the live registration
    // may use either prefix. Probe both, preferring the canonical one.
    let apiBasePromise = null
    async function API(path) {
      if (apiBasePromise === null) {
        apiBasePromise = (async () => {
          for (const candidate of ['/daily-plan-api', '/daily-tasks-api']) {
            try {
              const response = await fetch(candidate + '/version', { headers: { accept: 'application/json' } })
              if (response.ok) return candidate
            } catch {
              // try the next candidate
            }
          }
          return '/daily-plan-api'
        })()
      }
      const base = await apiBasePromise
      return base + path
    }

    async function apiGet(path) {
      const response = await fetch(await API(path), { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      if (!response.ok || (payload && payload.error)) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    async function apiPost(path, body) {
      const response = await fetch(await API(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      if (!response.ok || (payload && payload.error)) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    // ---- time helpers -------------------------------------------------

    const DAY = 86400000
    const pad2 = value => String(value).padStart(2, '0')

    function startOfDay(date) {
      const copy = new Date(date)
      copy.setHours(0, 0, 0, 0)
      return copy
    }

    function addDays(date, count) {
      const copy = new Date(date)
      copy.setDate(copy.getDate() + count)
      return copy
    }

    function sameDay(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    }

    const monthDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
    const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

    /** "今天" / "明天" / "11月30日 周一". */
    function dayLabel(date, now, t) {
      const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY)
      if (days === 0) return t('time.today')
      if (days === 1) return t('time.tomorrow')
      if (days === 2) return t('time.dayAfter')
      if (days === -1) return t('time.yesterday')
      const absolute = monthDayFormat.format(date)
      return Math.abs(days) < 7 ? `${absolute} ${weekdayFormat.format(date)}` : absolute
    }

    /** The chip on one task: "今天 14:30" or "明天 · 全天". */
    function dueChip(task, now, t) {
      if (!task.due) return t('time.unscheduled')
      const due = new Date(task.due)
      const label = dayLabel(due, now, t)
      return task.allDay ? `${label} · ${t('time.allDay')}` : `${label} ${pad2(due.getHours())}:${pad2(due.getMinutes())}`
    }

    function formatClock(totalSeconds) {
      const total = Math.max(0, Math.ceil(totalSeconds))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`
    }

    function localDateValue(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    function localTimeValue(date) {
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function composeDue(dateText, timeText) {
      if (!dateText) return null
      const due = new Date(`${dateText}T${timeText || '23:59'}`)
      return Number.isFinite(due.getTime()) ? due : null
    }

    function isOverdue(task, now) {
      if (task.done || !task.due) return false
      const due = new Date(task.due)
      if (task.allDay) return startOfDay(due) < startOfDay(now)
      return due.getTime() < now
    }

    function overdueText(task, now, t) {
      const late = now - new Date(task.due).getTime()
      if (late < 3600000) return `${t('time.late')} ${Math.max(1, Math.round(late / 60000))}${t('unit.minutesShort')}`
      if (late < DAY) return `${t('time.late')} ${Math.round(late / 3600000)}${t('unit.hoursShort')}`
      return `${t('time.late')} ${Math.round(late / DAY)}${t('unit.daysShort')}`
    }

    // ---- focus sound and full screen ----------------------------------

    function chime() {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return
        const audio = new Ctor()
        const note = (freq, at, duration) => {
          const oscillator = audio.createOscillator()
          const gain = audio.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.value = freq
          gain.gain.setValueAtTime(0, at)
          gain.gain.linearRampToValueAtTime(0.16, at + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
          oscillator.connect(gain)
          gain.connect(audio.destination)
          oscillator.start(at)
          oscillator.stop(at + duration + 0.05)
        }
        note(880, audio.currentTime, 0.22)
        note(1318, audio.currentTime + 0.26, 0.42)
        window.setTimeout(() => { try { audio.close() } catch { /* already closed */ } }, 1400)
      } catch {
        // A blocked audio context must never break the timer.
      }
    }

    function enterFullscreen() {
      try {
        const element = document.documentElement
        if (!document.fullscreenElement && element.requestFullscreen) {
          const pending = element.requestFullscreen()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        }
      } catch {
        // The overlay already covers the page; full screen is an enhancement.
      }
    }

    function leaveFullscreen() {
      try {
        if (document.fullscreenElement && document.exitFullscreen) {
          const pending = document.exitFullscreen()
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        }
      } catch {
        // nothing to leave
      }
    }

    // ---- dictionaries -------------------------------------------------

    const zh = {
      'panel.title': '每日任务',
      'hero.title': '今日任务',
      'hero.sub': '按截止时间排列',
      'hero.open': '待办',
      'hero.done': '已完成',
      'nav.prev': '前一天',
      'nav.next': '后一天',
      'nav.today': '回到今天',
      'add.placeholder': '要做什么？回车即可添加',
      'add.button': '添加任务',
      'add.date': '日期',
      'add.time': '时间',
      'add.note': '备注',
      'add.notePlaceholder': '补充说明（可选）',
      'add.quickToday': '今天',
      'add.quickTomorrow': '明天',
      'add.quickDayAfter': '后天',
      'add.priority': '优先级',
      'add.hint': '时间留空即视为全天事项',
      'group.overdue': '已逾期',
      'group.before': '之前',
      'group.am': '上午 · 12:00 前',
      'group.pm': '下午 · 12:00–18:00',
      'group.eve': '晚上 · 18:00 后',
      'group.allDay': '全天',
      'group.later': '之后',
      'group.someday': '暂未安排时间',
      'group.done': '已完成',
      'task.start': '开干吧',
      'task.edit': '编辑',
      'task.delete': '删除',
      'task.save': '保存',
      'task.cancel': '取消',
      'task.note': '备注',
      'task.focus': '已专注 {count} 次 · {minutes} 分钟',
      'priority.normal': '普通',
      'priority.high': '重要',
      'priority.low': '次要',
      'repeat.label': '重复',
      'repeat.none': '不重复',
      'repeat.daily': '每天',
      'repeat.weekdays': '工作日',
      'repeat.weekly': '每周',
      'repeat.monthly': '每月',
      'remind.toggle': '提醒',
      'remind.on': '到期提醒已开启（面板打开时提醒）',
      'remind.off': '到期提醒已关闭',
      'remind.due': '⏰「{title}」到时间了',
      'toast.close': '关闭',
      'shortcut.hint': '按 / 快速输入',
      'focus.resetConfirm': '重置正在进行的计时？',
      'focus.resetYes': '重置',
      'focus.resetNo': '保留',
      'view.plan': '待办清单',
      'view.history': '已完成记录',
      'history.title': '已完成记录',
      'history.sub': '按完成时间倒序 · 可导出',
      'history.all': '全部',
      'history.week': '最近 7 天',
      'history.month': '最近 30 天',
      'history.custom': '自定义',
      'history.from': '开始日期',
      'history.to': '结束日期',
      'history.rangeSep': '至',
      'history.count': '{n} 条',
      'history.empty': '这段时间没有已完成任务',
      'history.emptyHint': '完成的待办会记录在这里，可导出为 Markdown 或 Excel。',
      'history.colTime': '完成时间',
      'history.colTask': '任务',
      'history.colNote': '备注',
      'history.colDue': '截止时间',
      'history.exportMd': '导出 Markdown',
      'history.exportXlsx': '导出 Excel',
      'history.exported': '已开始下载',
      'sort.label': '排序',
      'sort.time': '按时间',
      'sort.urgency': '按紧急程度',
      'urgency.overdue': '已逾期',
      'urgency.high': '紧急',
      'urgency.medium': '较急',
      'urgency.normal': '普通',
      'quote.1': '一件一件来，今天也能完成一些事。',
      'quote.2': '先做最重要的那件，剩下的会变轻。',
      'quote.3': '进度慢没关系，别停下来就行。',
      'quote.4': '把小事做完，也是在给自己攒信心。',
      'quote.5': '今天完成一件，就是往前走了一步。',
      'quote.6': '开始比完美重要，先动起来。',
      'quote.7': '专注 25 分钟，然后奖励自己一杯水。',
      'quote.8': '清单是工具，不是压力，慢慢来。',
      'quote.kind.poetry': '诗词',
      'quote.kind.sentence': '句子',
      'quote.kind.movie': '电影台词',
      'quote.kind.english': '英文',
      'quote.refresh': '换一句',
      'quote.stale': '网络语录暂时不可用，正在显示上次内容',
      'encourage.1': '完成一件，真不错！',
      'encourage.2': '又清掉一项，继续保持。',
      'encourage.3': '漂亮，进度在往前走。',
      'encourage.4': '这一件做完了，给自己点个赞。',
      'encourage.5': '很棒，今天的你又靠谱了一点。',
      'encourage.6': '干得漂亮，下一件也不慌。',
      'encourage.7': '完成就是胜利，继续。',
      'encourage.8': '稳扎稳打，节奏很好。',
      'encourage.first': '今天的第一个完成项！好开端。',
      'encourage.three': '已经完成 3 件了，状态在线。',
      'encourage.five': '完成 5 件！今天很能打。',
      'encourage.ten': '完成 10 件！这效率值得休息一下。',
      'encourage.allDone': '今天的待办全部清空，收工！',
      'empty.title': '这一天还没有任务',
      'empty.hint': '在上面写一条，选好完成时间就行。',
      'error.load': '读取任务失败',
      'error.retry': '重试',
      'error.save': '保存失败',
      'error.title': '任务标题不能为空',
      'loading': '读取中…',
      'undo.deleted': '已删除「{title}」',
      'undo.button': '撤销',
      'clear.confirm': '清理这天的 {n} 条已完成任务？',
      'clear.yes': '确认清理',
      'clear.cancel': '取消',
      'status.count': '{open} 件待办 · {done} 件已完成',
      'status.clearDone': '清理已完成',
      'sync.title': '云同步',
      'sync.never': '尚未同步',
      'sync.justNow': '刚刚',
      'sync.minutesAgo': '{n} 分钟前',
      'sync.hoursAgo': '{n} 小时前',
      'sync.daysAgo': '{n} 天前',
      'sync.ok': '已同步 · {ago}',
      'sync.last': '上次同步 · {ago}',
      'sync.busy': '同步中…',
      'sync.unconfigured': '云同步需要重新配置',
      'sync.syncing': '同步中',
      'sync.error': '同步失败',
      'sync.now': '立即同步',
      'focus.title': '专注',
      'focus.doing': '正在进行',
      'focus.pause': '暂停',
      'focus.resume': '继续',
      'focus.finish': '完成',
      'focus.exit': '退出专注',
      'focus.finished': '时间到',
      'focus.again': '再来 5 分钟',
      'focus.duration': '时长',
      'focus.minutes': '{n} 分钟',
      'focus.total': '本次 {n} 分钟',
      'focus.hint': '按 Esc 先退出全屏，再按一次退出专注',
      'time.today': '今天',
      'time.tomorrow': '明天',
      'time.dayAfter': '后天',
      'time.yesterday': '昨天',
      'time.allDay': '全天',
      'time.unscheduled': '未定时间',
      'time.late': '已超时',
      'unit.minutesShort': '分钟',
      'unit.hoursShort': '小时',
      'unit.daysShort': '天',
      'unit.minutes': '分钟',
    }

    const en = {
      'panel.title': 'Daily plan',
      'hero.title': "Today's tasks",
      'hero.sub': 'grouped by due time',
      'hero.open': 'Open',
      'hero.done': 'Done',
      'nav.prev': 'Previous day',
      'nav.next': 'Next day',
      'nav.today': 'Back to today',
      'add.placeholder': 'What needs doing? Press Enter',
      'add.button': 'Add task',
      'add.date': 'Date',
      'add.time': 'Time',
      'add.note': 'Note',
      'add.notePlaceholder': 'Optional details',
      'add.quickToday': 'Today',
      'add.quickTomorrow': 'Tomorrow',
      'add.quickDayAfter': 'In two days',
      'add.priority': 'Priority',
      'add.hint': 'Leave the time empty for an all-day task',
      'group.overdue': 'Overdue',
      'group.before': 'Earlier',
      'group.am': 'Morning · before 12:00',
      'group.pm': 'Afternoon · 12:00–18:00',
      'group.eve': 'Evening · after 18:00',
      'group.allDay': 'All day',
      'group.later': 'Later',
      'group.someday': 'No time set',
      'group.done': 'Done',
      'task.start': 'Start focus',
      'task.edit': 'Edit',
      'task.delete': 'Delete',
      'task.save': 'Save',
      'task.cancel': 'Cancel',
      'task.note': 'Note',
      'task.focus': 'Focused {count}× · {minutes} min',
      'priority.normal': 'Normal',
      'priority.high': 'Important',
      'priority.low': 'Minor',
      'repeat.label': 'Repeat',
      'repeat.none': 'No repeat',
      'repeat.daily': 'Daily',
      'repeat.weekdays': 'Weekdays',
      'repeat.weekly': 'Weekly',
      'repeat.monthly': 'Monthly',
      'remind.toggle': 'Remind',
      'remind.on': 'Due reminders on (while the panel is open)',
      'remind.off': 'Due reminders off',
      'remind.due': '⏰ “{title}” is due',
      'toast.close': 'Close',
      'shortcut.hint': 'Press / to type',
      'focus.resetConfirm': 'Reset the running timer?',
      'focus.resetYes': 'Reset',
      'focus.resetNo': 'Keep',
      'view.plan': 'Plan',
      'view.history': 'Completed',
      'history.title': 'Completed tasks',
      'history.sub': 'Newest first · exportable',
      'history.all': 'All',
      'history.week': 'Last 7 days',
      'history.month': 'Last 30 days',
      'history.custom': 'Custom',
      'history.from': 'From',
      'history.to': 'To',
      'history.rangeSep': 'to',
      'history.count': '{n} items',
      'history.empty': 'Nothing completed in this period',
      'history.emptyHint': 'Finished tasks are recorded here and can be exported as Markdown or Excel.',
      'history.colTime': 'Completed at',
      'history.colTask': 'Task',
      'history.colNote': 'Note',
      'history.colDue': 'Due',
      'history.exportMd': 'Export Markdown',
      'history.exportXlsx': 'Export Excel',
      'history.exported': 'Download started',
      'sort.label': 'Sort',
      'sort.time': 'By time',
      'sort.urgency': 'By urgency',
      'urgency.overdue': 'Overdue',
      'urgency.high': 'Urgent',
      'urgency.medium': 'Soon',
      'urgency.normal': 'Normal',
      'quote.1': 'One thing at a time — you can finish a few today.',
      'quote.2': 'Start with the most important one; the rest get lighter.',
      'quote.3': "Slow progress is fine. Don't stop.",
      'quote.4': 'Finishing small things builds confidence too.',
      'quote.5': 'One task done today is one step forward.',
      'quote.6': 'Starting beats perfect. Just begin.',
      'quote.7': 'Focus for 25 minutes, then reward yourself.',
      'quote.8': "A list is a tool, not pressure. Take it easy.",
      'quote.kind.poetry': 'Poetry',
      'quote.kind.sentence': 'Quote',
      'quote.kind.movie': 'Movie line',
      'quote.kind.english': 'English',
      'quote.refresh': 'Another one',
      'quote.stale': 'Network quote unavailable; showing the previous one.',
      'encourage.1': 'One done — nice work!',
      'encourage.2': 'Another one cleared. Keep going.',
      'encourage.3': 'Beautiful. The list is shrinking.',
      'encourage.4': 'That one is finished — give yourself credit.',
      'encourage.5': "Great job. You're a bit more reliable today.",
      'encourage.6': "Nicely done. The next one won't scare you.",
      'encourage.7': 'Finishing is winning. Onward.',
      'encourage.8': 'Steady pace. Looking good.',
      'encourage.first': 'First completion of the day! Great start.',
      'encourage.three': 'Three done already — you are in the zone.',
      'encourage.five': 'Five done! Strong day.',
      'encourage.ten': 'Ten done! That deserves a break.',
      'encourage.allDone': 'Everything on today\'s list is done. Wrap up!',
      'empty.title': 'Nothing planned for this day',
      'empty.hint': 'Write one above and pick when it is due.',
      'error.load': 'Could not load tasks',
      'error.retry': 'Retry',
      'error.save': 'Could not save',
      'error.title': 'A task needs a title',
      'loading': 'Loading…',
      'undo.deleted': 'Deleted “{title}”',
      'undo.button': 'Undo',
      'clear.confirm': 'Clear the {n} finished tasks of this day?',
      'clear.yes': 'Clear',
      'clear.cancel': 'Cancel',
      'status.count': '{open} open · {done} done',
      'status.clearDone': 'Clear finished',
      'sync.title': 'Cloud sync',
      'sync.never': 'Not synced yet',
      'sync.justNow': 'just now',
      'sync.minutesAgo': '{n} min ago',
      'sync.hoursAgo': '{n} h ago',
      'sync.daysAgo': '{n} d ago',
      'sync.ok': 'Synced · {ago}',
      'sync.last': 'Last sync · {ago}',
      'sync.busy': 'Syncing…',
      'sync.unconfigured': 'Cloud sync needs setup',
      'sync.syncing': 'Syncing',
      'sync.error': 'Sync failed',
      'sync.now': 'Sync now',
      'focus.title': 'Focus',
      'focus.doing': 'Working on',
      'focus.pause': 'Pause',
      'focus.resume': 'Resume',
      'focus.finish': 'Finish',
      'focus.exit': 'Leave focus',
      'focus.finished': "Time's up",
      'focus.again': 'Five more minutes',
      'focus.duration': 'Length',
      'focus.minutes': '{n} min',
      'focus.total': '{n} min this session',
      'focus.hint': 'Esc leaves full screen first, then the focus view',
      'time.today': 'Today',
      'time.tomorrow': 'Tomorrow',
      'time.dayAfter': 'In two days',
      'time.yesterday': 'Yesterday',
      'time.allDay': 'all day',
      'time.unscheduled': 'no time',
      'time.late': 'overdue',
      'unit.minutesShort': 'm',
      'unit.hoursShort': 'h',
      'unit.daysShort': 'd',
      'unit.minutes': 'min',
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    // A last-resort translator for the case where the slot supplies no `t`.
    const bootDict = String(navigator.language || '').toLowerCase().startsWith('zh') ? zh : en
    const localT = key => (bootDict[key] === undefined ? key : bootDict[key])

    /** "just now" / "12 min ago", for the cloud-sync chip. */
    function agoText(t, time) {
      if (!time) return t('sync.never')
      const delta = Math.max(0, Date.now() - time)
      if (delta < 60 * 1000) return t('sync.justNow')
      const minutes = Math.floor(delta / (60 * 1000))
      if (minutes < 60) return fill(t('sync.minutesAgo'), { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return fill(t('sync.hoursAgo'), { n: hours })
      return fill(t('sync.daysAgo'), { n: Math.floor(hours / 24) })
    }

    /** "2026-11-25 22:03", used by the completed history and the export URLs. */
    function stampText(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /** Finished tasks inside [from, to), newest first (same rule as the host export). */
    function completedBetween(tasks, from, to) {
      return (Array.isArray(tasks) ? tasks : [])
        .filter(task => task && task.done === true)
        .filter(task => Number.isFinite(task.completedAt) && task.completedAt >= from && task.completedAt < to)
        .sort((a, b) => b.completedAt - a.completedAt)
    }

    const SORT_KEY = 'dsh.daily-plan.sort'
    const HOUR = 3600000

    /** Higher means more urgent: overdue > due soon > priority > everything else. */
    function urgencyScore(task, now) {
      const priority = task.priority === 'high' ? 150 : task.priority === 'low' ? -60 : 0
      if (!task.due) return 60 + priority
      const due = new Date(task.due).getTime()
      if (!Number.isFinite(due)) return 60 + priority
      if (isOverdue(task, now)) {
        const hoursLate = Math.min(240, (now - due) / HOUR)
        return 10000 + hoursLate * 5 + priority
      }
      const delta = due - now
      let base
      if (delta <= HOUR) base = 900
      else if (delta <= 6 * HOUR) base = 800
      else if (delta <= 24 * HOUR) base = 650
      else if (delta <= 72 * HOUR) base = 450
      else if (delta <= 7 * 24 * HOUR) base = 250
      else base = 120
      return base + priority
    }

    /** Which short label explains a task's urgency. */
    function urgencyLabel(task, now) {
      if (isOverdue(task, now)) return 'urgency.overdue'
      if (task.priority === 'high') return 'urgency.high'
      if (!task.due) return 'urgency.normal'
      const delta = new Date(task.due).getTime() - now
      if (delta <= 24 * HOUR) return 'urgency.high'
      if (delta <= 72 * HOUR) return 'urgency.medium'
      return 'urgency.normal'
    }

    // ---- styles -------------------------------------------------------

    const STYLES = `
      .dp-page { height: 100%; overflow: hidden; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13.5px; line-height: 1.45; --dp-solid: #f7f8fa; --dp-card: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, transparent); }
      body[data-ds-dark-theme] .dp-page { --dp-solid: #0b0f16; }
      .dp-shell { max-width: 1180px; margin: 0 auto; padding: 14px 16px; height: 100%; box-sizing: border-box; display: flex; }
      .dp-surface { flex: 1; min-height: 0; display: flex; flex-direction: column; background: linear-gradient(color-mix(in srgb, var(--dp-card) 86%, transparent), color-mix(in srgb, var(--dp-card) 86%, transparent)), color-mix(in srgb, var(--dp-solid) 78%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 18px; padding: 18px 22px 14px; backdrop-filter: blur(20px); box-shadow: 0 10px 40px rgba(0,0,0,.10); overflow: hidden; }
      .dp-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 2px 4px 0 0; margin-right: -4px; }
      .dp-plan { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .dp-history { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .dp-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; flex: none; }
      .dp-hero-title { font-size: 22px; font-weight: 700; letter-spacing: -.012em; }
      .dp-hero-sub { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dp-quote-bar { flex: none; display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin-top: 12px; padding: 12px 16px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent); background: linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent), transparent 74%); }
      .dp-quote-mark { font-size: 22px; font-weight: 700; line-height: 1; color: var(--dsw-alias-brand-primary); opacity: .5; }
      .dp-quote-text { font-size: 17.5px; font-weight: 650; line-height: 1.5; letter-spacing: .01em; color: var(--dsw-alias-brand-primary); }
      .dp-quote-from { font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
      .dp-quote-kind { padding: 1px 9px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary); font-size: 10.5px; font-weight: 600; letter-spacing: .02em; }
      .dp-quote-bar .dp-btn { padding: 2px 8px; font-size: 12px; }
      .dp-sort { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; overflow: hidden; }
      .dp-sort-btn { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
      .dp-sort-btn:hover { color: var(--dsw-alias-label-primary); }
      .dp-sort-btn[data-active="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 600; }
      .dp-stats { display: flex; gap: 20px; }
      .dp-stat { text-align: right; }
      .dp-stat-num { font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
      .dp-stat-num[data-tone="done"] { color: var(--dsw-alias-state-success-primary); }
      .dp-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
      .dp-progress { height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin: 14px 0 16px; }
      .dp-progress span { display: block; height: 100%; background: var(--dsw-alias-state-success-primary); transition: width .35s ease; }
      .dp-daynav { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
      .dp-daynav-label { font-weight: 600; font-size: 14px; font-variant-numeric: tabular-nums; }
      .dp-daynav-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .dp-spacer { flex: 1; }
      .dp-icon-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); width: 28px; height: 28px; border-radius: 9px; cursor: pointer; font: inherit; display: inline-flex; align-items: center; justify-content: center; }
      .dp-icon-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .dp-link { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 3px 8px; border-radius: 7px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
      .dp-link:hover { color: var(--dsw-alias-label-primary); }
      .dp-compose { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
      .dp-compose-top { display: flex; gap: 8px; }
      .dp-input, .dp-select { font: inherit; color: inherit; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 6px 9px; outline: none; min-width: 0; box-sizing: border-box; }
      .dp-input:focus, .dp-select:focus { border-color: var(--dsw-alias-brand-primary); }
      .dp-btn:focus-visible, .dp-icon-btn:focus-visible, .dp-link:focus-visible, .dp-check:focus-visible, .dp-sync:focus-visible, .dp-done-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dp-note-input { width: 100%; min-height: 54px; resize: vertical; line-height: 1.45; }
      .dp-btn.dp-toggle[data-active="true"] { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
      .dp-compose-top .dp-input { flex: 1; font-size: 14px; padding: 8px 11px; }
      .dp-compose-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .dp-compose-row .dp-input { padding: 4px 8px; font-size: 12px; }
      .dp-quick { display: inline-flex; gap: 4px; }
      .dp-quick button { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer; }
      .dp-quick button:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }
      .dp-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
      .dp-btn:hover { border-color: var(--dsw-alias-border-l2); }
      .dp-btn[data-primary="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent); color: var(--dsw-alias-label-primary); font-weight: 600; }
      .dp-btn[data-primary="true"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); border-color: var(--dsw-alias-brand-primary); }
      .dp-btn[data-primary="true"]:disabled { opacity: .55; cursor: default; }
      .dp-btn[data-quiet="true"] { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
      .dp-btn[data-quiet="true"]:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
      .dp-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
      .dp-btn[data-danger="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); border-color: var(--dsw-alias-state-error-primary); }
      .dp-section { margin-bottom: 18px; }
      .dp-group { display: flex; align-items: baseline; gap: 8px; padding: 0 4px 6px; font-size: 11.5px; font-weight: 700; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); }
      .dp-group[data-tone="danger"] { color: var(--dsw-alias-state-error-primary); }
      .dp-group-count { font-weight: 500; opacity: .75; font-variant-numeric: tabular-nums; }
      .dp-rows { display: flex; flex-direction: column; }
      .dp-row { display: flex; gap: 10px; align-items: flex-start; padding: 9px 10px; border-radius: 11px; border: 1px solid transparent; }
      .dp-row:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
      .dp-check { flex: none; width: 19px; height: 19px; margin-top: 1px; border-radius: 50%; border: 1.6px solid var(--dsw-alias-border-l2); background: transparent; color: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; transition: background .12s ease, border-color .12s ease; }
      .dp-check:hover { border-color: var(--dsw-alias-state-success-primary); }
      .dp-check[data-done="true"] { background: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); color: #fff; }
      .dp-main { flex: 1; min-width: 0; }
      .dp-title { line-height: 1.4; font-weight: 550; word-break: break-word; }
      .dp-row[data-done="true"] .dp-title { color: var(--dsw-alias-label-secondary); text-decoration: line-through; }
      .dp-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); align-items: center; }
      .dp-chip { padding: 0 7px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-variant-numeric: tabular-nums; line-height: 18px; }
      .dp-chip[data-tone="danger"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .dp-chip[data-tone="high"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
      .dp-chip[data-tone="repeat"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
      .dp-chip[data-tone="urgency"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
      .dp-note { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; }
      .dp-actions { display: flex; align-items: center; gap: 8px; flex: none; }
      .dp-actions .dp-btn { opacity: 0; transition: opacity .12s ease; }
      .dp-actions .dp-btn[data-danger="true"] { color: var(--dsw-alias-label-secondary); }
      .dp-actions .dp-btn[data-danger="true"]:hover { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
      .dp-row:hover .dp-actions .dp-btn, .dp-row:focus-within .dp-actions .dp-btn { opacity: 1; }
      .dp-actions .dp-btn[data-start="true"] { opacity: 1; color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); font-weight: 600; }
      .dp-actions .dp-btn[data-start="true"]:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); border-color: var(--dsw-alias-brand-primary); }
      .dp-edit { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 2px; }
      .dp-edit-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .dp-edit .dp-input { flex: 1; }
      .dp-empty { margin: auto 0; padding: 48px 18px; text-align: center; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l1); border-radius: 14px; }
      .dp-empty-title { font-weight: 650; color: var(--dsw-alias-label-primary); font-size: 14px; margin-bottom: 4px; }
      .dp-done-toggle { margin-top: 4px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 4px 4px; }
      .dp-done-toggle:hover { color: var(--dsw-alias-label-primary); }
      .dp-foot { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .dp-sync { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); background: transparent; color: var(--dsw-alias-brand-primary); font-size: 11px; cursor: pointer; white-space: nowrap; }
      .dp-sync:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
      .dp-sync:disabled { opacity: .7; cursor: default; }
      .dp-sync[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
      .dp-sync[data-tone="error"]:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
      .dp-warn { margin-bottom: 12px; padding: 8px 11px; border-radius: 9px; font-size: 12px; color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
      .dp-undo { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding: 8px 11px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
      .dp-undo .dp-btn { font-size: 11.5px; padding: 3px 9px; }
      .dp-loading { padding: 36px 18px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
      .dp-toast { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: 1300; display: flex; align-items: center; gap: 12px; max-width: min(560px, 88vw); padding: 9px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); backdrop-filter: blur(12px); box-shadow: 0 8px 28px rgba(0,0,0,.22); font-size: 12.5px; color: var(--dsw-alias-label-primary); animation: dp-toast-in .16s ease-out; }
      .dp-toast[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); color: var(--dsw-alias-state-error-primary); }
      .dp-toast[data-tone="warn"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
      .dp-toast-close { border: none; background: transparent; color: inherit; opacity: .6; font: inherit; font-size: 15px; line-height: 1; cursor: pointer; padding: 0 2px; }
      .dp-toast-close:hover { opacity: 1; }
      @keyframes dp-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
      .dp-error { margin-bottom: 12px; padding: 8px 11px; border-radius: 9px; font-size: 12px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); display: flex; gap: 10px; align-items: center; }
      .dp-focus { position: fixed; inset: 0; z-index: 2147483647; --dp-solid: #f7f8fa; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; background-color: color-mix(in srgb, var(--dp-solid) 88%, transparent); backdrop-filter: blur(26px); background-image: linear-gradient(var(--dsw-alias-bg-base), var(--dsw-alias-bg-base)), radial-gradient(115% 80% at 50% 0%, color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent) 0%, transparent 62%); animation: dp-fade .18s ease-out; }
      body[data-ds-dark-theme] .dp-focus { --dp-solid: #0b0f16; }
      @keyframes dp-fade { from { opacity: 0; } to { opacity: 1; } }
      .dp-focus-kicker { font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .dp-focus-task { font-size: clamp(17px, 2.4vw, 25px); font-weight: 650; text-align: center; max-width: min(720px, 86vw); line-height: 1.3; }
      .dp-ring { position: relative; width: min(300px, 62vw); height: min(300px, 62vw); display: flex; align-items: center; justify-content: center; }
      .dp-ring svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
      .dp-ring-inner { display: flex; flex-direction: column; align-items: center; }
      .dp-ring-time { font-size: clamp(44px, 8vw, 82px); font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: 1; }
      .dp-ring-total { margin-top: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: center; }
      .dp-focus[data-finished="true"] .dp-ring-time { color: var(--dsw-alias-state-success-primary); }
      .dp-focus-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
      .dp-focus-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 7px 16px; border-radius: 10px; cursor: pointer; }
      .dp-focus-btn:hover { border-color: var(--dsw-alias-border-l2); }
      .dp-focus-btn[data-primary="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 60%, transparent); color: var(--dsw-alias-label-primary); font-weight: 650; }
      .dp-focus-presets { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dp-focus-presets button { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 3px 11px; border-radius: 999px; cursor: pointer; font-variant-numeric: tabular-nums; }
      .dp-focus-presets button[data-active="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .dp-focus-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: .85; }
      .dp-focus-reset { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dp-tabs { display: flex; gap: 6px; margin: 2px 0 12px; flex: none; }
      .dp-tab { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 999px; cursor: pointer; }
      .dp-tab:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .dp-tab[data-active="true"] { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); font-weight: 600; }
      .dp-history-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      .dp-history-dates { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .dp-history-dates .dp-input { padding: 3px 6px; font-size: 12px; }
      .dp-history-scroll { overflow-x: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; }
      .dp-history-empty { margin: auto 0; }
      .dp-history-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .dp-history-table th { text-align: left; padding: 8px 10px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-weight: 600; white-space: nowrap; }
      .dp-history-table td { padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
      .dp-history-table tr:hover td { background: var(--dsw-alias-bg-layer-2); }
      .dp-history-time { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
      .dp-history-task { font-weight: 550; word-break: break-word; }
      .dp-history-note { color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; max-width: 260px; }
      .dp-history-empty { padding: 36px 18px; text-align: center; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l1); border-radius: 14px; }
      .dp-quick button[data-active="true"] { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
      @media (max-width: 700px) {
        .dp-shell { padding: 10px 10px; }
        .dp-surface { padding: 14px 14px 10px; }
        .dp-hero-title { font-size: 19px; }
        .dp-actions .dp-btn { opacity: 1; }
        .dp-history-note { max-width: none; }
        .dp-quote-bar { padding: 10px 12px; }
        .dp-quote-text { font-size: 15px; }
      }
    `

    // ---- pieces -------------------------------------------------------

    const GLYPH_PATHS = [
      ['rect', { x: 7, y: 9.5, width: 22, height: 20, rx: 4, fill: 'none', stroke: 'currentColor', strokeWidth: 2.1, opacity: 0.55 }],
      ['path', { d: 'M12 5.7V9.4', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', opacity: 0.55 }],
      ['path', { d: 'M24 5.7V9.4', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', opacity: 0.55 }],
      ['path', { d: 'M12.2 21.1L16.4 24.9L24.9 13.7', fill: 'none', stroke: 'currentColor', strokeWidth: 3.1, strokeLinecap: 'round', strokeLinejoin: 'round' }],
    ]

    /** The left-sidebar row icon; the shell owns the button and its label. */
    function PanelIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 36 36', 'aria-hidden': 'true',
        style: { display: 'block', opacity: props && props.active === false ? 0.75 : 1 },
      }, GLYPH_PATHS.map(([tag, attributes], index) => h(tag, { key: index, ...attributes })))
    }

    function TaskRow(props) {
      const { task, now, t, busy, onToggle, onStart, onDelete, onSave, editing, setEditing, showUrgency } = props
      const overdue = isOverdue(task, now)
      const openEditor = () => {
        const due = task.due ? new Date(task.due) : null
        setEditing({
          id: task.id,
          title: task.title,
          date: due ? localDateValue(due) : '',
          time: due && !task.allDay ? localTimeValue(due) : '',
          note: task.note || '',
          priority: task.priority || 'normal',
          repeat: task.repeat || 'none',
        })
      }
      if (editing && editing.id === task.id) {
        return h('div', { className: 'dp-row' },
          h('div', { className: 'dp-main' },
            h('div', { className: 'dp-edit' },
              h('input', {
                className: 'dp-input', value: editing.title, autoFocus: true,
                placeholder: t('add.placeholder'), 'aria-label': t('add.placeholder'),
                onChange: event => setEditing({ ...editing, title: event.target.value }),
                onKeyDown: event => {
                  if (event.key === 'Enter') onSave()
                  if (event.key === 'Escape') setEditing(null)
                },
              }),
              h('div', { className: 'dp-edit-row' },
                h('input', {
                  className: 'dp-input', type: 'date', value: editing.date,
                  'aria-label': t('add.date'), style: { flex: '1 1 130px' },
                  onChange: event => setEditing({ ...editing, date: event.target.value }),
                }),
                h('input', {
                  className: 'dp-input', type: 'time', value: editing.time,
                  'aria-label': t('add.time'), style: { flex: '0 1 110px' },
                  onChange: event => setEditing({ ...editing, time: event.target.value }),
                }),
                h('select', {
                  className: 'dp-select', value: editing.priority, 'aria-label': t('add.priority'),
                  onChange: event => setEditing({ ...editing, priority: event.target.value }),
                }, ['normal', 'high', 'low'].map(level => h('option', { key: level, value: level }, t(`priority.${level}`)))),
                h('select', {
                  className: 'dp-select', value: editing.repeat || 'none', 'aria-label': t('repeat.label'),
                  onChange: event => setEditing({ ...editing, repeat: event.target.value }),
                }, REPEAT_VALUES.map(value => h('option', { key: value, value }, t(`repeat.${value}`))))),
              h('textarea', {
                className: 'dp-input dp-note-input', value: editing.note, placeholder: t('add.notePlaceholder'),
                'aria-label': t('add.note'), rows: 2,
                onChange: event => setEditing({ ...editing, note: event.target.value }),
              }),
              h('div', { className: 'dp-edit-row' },
                h('button', { className: 'dp-btn', 'data-primary': 'true', onClick: onSave, disabled: busy }, t('task.save')),
                h('button', { className: 'dp-btn', 'data-quiet': 'true', onClick: () => setEditing(null) }, t('task.cancel'))))))
      }
      const meta = []
      if (task.due) {
        meta.push(h('span', { key: 'due', className: 'dp-chip', 'data-tone': overdue ? 'danger' : undefined }, dueChip(task, now, t)))
        if (overdue) meta.push(h('span', { key: 'late', className: 'dp-chip', 'data-tone': 'danger' }, overdueText(task, now, t)))
      } else {
        meta.push(h('span', { key: 'none', className: 'dp-chip' }, t('time.unscheduled')))
      }
      if (task.priority === 'high') meta.push(h('span', { key: 'prio', className: 'dp-chip', 'data-tone': 'high' }, t('priority.high')))
      if (task.repeat && task.repeat !== 'none') {
        meta.push(h('span', { key: 'repeat', className: 'dp-chip', 'data-tone': 'repeat' }, `🔁 ${t(`repeat.${task.repeat}`)}`))
      }
      if (showUrgency && !task.done) {
        meta.push(h('span', { key: 'urgency', className: 'dp-chip', 'data-tone': 'urgency' }, t(urgencyLabel(task, now))))
      }
      if (task.focusCount > 0) {
        meta.push(h('span', { key: 'focus' }, fill(t('task.focus'), {
          count: task.focusCount,
          minutes: Math.max(1, Math.round(task.focusSeconds / MINUTE)),
        })))
      }
      const actions = h('div', { className: 'dp-actions' },
        task.done ? null : h('button', { className: 'dp-btn', 'data-start': 'true', onClick: onStart, title: t('task.start') }, t('task.start')),
        h('button', { className: 'dp-btn', 'data-quiet': 'true', onClick: openEditor, title: t('task.edit'), 'aria-label': t('task.edit') }, t('task.edit')),
        h('button', { className: 'dp-btn', 'data-quiet': 'true', 'data-danger': 'true', onClick: onDelete, title: t('task.delete'), 'aria-label': t('task.delete') }, '×'))
      return h('div', { className: 'dp-row', 'data-done': String(task.done) },
        h('button', {
          className: 'dp-check', 'data-done': String(task.done),
          role: 'checkbox', 'aria-checked': String(task.done), 'aria-label': task.title,
          onClick: onToggle,
        }, h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
          h('polyline', { points: '2.2,6.3 4.8,8.8 9.8,3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
        h('div', { className: 'dp-main' },
          h('div', { className: 'dp-title' }, task.title),
          h('div', { className: 'dp-meta' }, meta),
          task.note ? h('div', { className: 'dp-note' }, task.note) : null),
        actions)
    }

    function FocusRing(props) {
      const radius = 46
      const circumference = 2 * Math.PI * radius
      const progress = props.duration > 0 ? Math.max(0, Math.min(1, props.remaining / props.duration)) : 0
      return h('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' },
        h('circle', { cx: 50, cy: 50, r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 2.2 }),
        h('circle', {
          cx: 50, cy: 50, r: radius, fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 3.4, strokeLinecap: 'round',
          strokeDasharray: `${circumference} ${circumference}`,
          strokeDashoffset: circumference * (1 - progress),
          style: { transition: 'stroke-dashoffset .35s linear' },
        }))
    }

    // ---- the page -----------------------------------------------------

    function DailyPage(props) {
      const t = props.t || localT
      const [day, setDay] = useState(() => startOfDay(new Date()))
      const [tasks, setTasks] = useState([])
      const [warning, setWarning] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [now, setNow] = useState(Date.now())
      const [showDone, setShowDone] = useState(false)
      const [editing, setEditing] = useState(null)
      const [draft, setDraft] = useState(() => ({
        title: '',
        date: localDateValue(new Date()),
        time: '',
        note: '',
        priority: 'normal',
        repeat: 'none',
        noteOpen: false,
      }))
      const [minutes, setMinutes] = useState(() => {
        try {
          const stored = JSON.parse(window.localStorage.getItem(PREF_KEY) || '{}')
          return FOCUS_PRESETS.includes(stored.minutes) ? stored.minutes : 25
        } catch {
          return 25
        }
      })
      const [focus, setFocus] = useState(null)
      const [sync, setSync] = useState(null)
      const [quote, setQuote] = useState(null)
      const [loaded, setLoaded] = useState(false)
      const [syncBusy, setSyncBusy] = useState(false)
      const [undo, setUndo] = useState(null)
      const [confirmClear, setConfirmClear] = useState(false)
      const [view, setView] = useState('plan')
      const [historyRange, setHistoryRange] = useState('all')
      const [sortMode, setSortMode] = useState(() => {
        try {
          return window.localStorage.getItem(SORT_KEY) === 'urgency' ? 'urgency' : 'time'
        } catch {
          return 'time'
        }
      })
      const [customFrom, setCustomFrom] = useState('')
      const [customTo, setCustomTo] = useState('')
      const [remindOn, setRemindOn] = useState(() => {
        try {
          return window.localStorage.getItem(REMIND_KEY) === '1'
        } catch {
          return false
        }
      })
      const [presetReset, setPresetReset] = useState(null)
      const syncEnabled = Boolean(sync && sync.enabled)
      const requestId = useRef(0)
      const finishedRef = useRef(false)
      const titleRef = useRef(null)
      const notifiedRef = useRef(new Set())

      const showToast = useCallback((text, tone = 'info') => {
        setToast({ text, tone, at: Date.now() })
      }, [])

      // Toasts dismiss themselves; the close button is only an escape hatch.
      useEffect(() => {
        if (!toast) return undefined
        const timer = window.setTimeout(() => setToast(null), 4800)
        return () => window.clearTimeout(timer)
      }, [toast])

      const applyState = useCallback(payload => {
        if (!payload) return
        if (Array.isArray(payload.tasks)) setTasks(payload.tasks)
        if (payload.sync !== undefined) setSync(payload.sync || null)
        setWarning(payload.storageWarning || null)
      }, [])

      const refresh = useCallback(async () => {
        const ticket = ++requestId.current
        try {
          const payload = await apiGet('/state')
          if (ticket !== requestId.current) return
          applyState(payload)
          setError(null)
        } catch (failure) {
          if (ticket === requestId.current) setError(failure.message)
        } finally {
          if (ticket === requestId.current) setLoaded(true)
        }
      }, [applyState])

      const syncNow = useCallback(async () => {
        if (syncBusy) return
        // A configured-but-broken sync cannot run a round; surface the saved
        // configuration error instead of silently doing nothing.
        if (sync && sync.configError && !sync.enabled) {
          showToast(sync.configError, 'error')
          return
        }
        setSyncBusy(true)
        try {
          const payload = await apiPost('/sync/now', {})
          applyState(payload)
        } catch (failure) {
          showToast(`${t('sync.error')}：${failure.message}`, 'error')
        } finally {
          setSyncBusy(false)
        }
      }, [applyState, syncBusy, sync, t, showToast])

      const mutate = useCallback(async body => {
        setBusy(true)
        try {
          const payload = await apiPost('/mutate', body)
          applyState(payload)
          return payload
        } catch (failure) {
          showToast(failure.message, 'error')
          return null
        } finally {
          setBusy(false)
        }
      }, [applyState, showToast])

      useEffect(() => {
        try {
          window.localStorage.setItem(SORT_KEY, sortMode)
        } catch {
          // preferences are best effort
        }
      }, [sortMode])

      /** Encouragement after finishing a task: milestones first, then variety. */
      const celebrate = useCallback(updated => {
        const todayStart = startOfDay(new Date()).getTime()
        const todayEnd = addDays(todayStart, 1).getTime()
        const list = Array.isArray(updated) ? updated : []
        const doneToday = list.filter(task => task.done
          && Number.isFinite(task.completedAt)
          && task.completedAt >= todayStart
          && task.completedAt < todayEnd).length
        if (doneToday > 0 && list.every(task => task.done)) {
          showToast(t('encourage.allDone'))
          return
        }
        const milestone = [[1, 'encourage.first'], [3, 'encourage.three'], [5, 'encourage.five'], [10, 'encourage.ten']]
          .find(([count]) => count === doneToday)
        if (milestone) {
          showToast(t(milestone[1]))
          return
        }
        showToast(t(`encourage.${1 + Math.floor(Math.random() * 8)}`))
      }, [showToast, t])

      const deleteTask = useCallback(async task => {
        const ok = await mutate({ op: 'delete', id: task.id })
        if (ok) {
          setUndo({ task })
          setConfirmClear(false)
        }
        return ok
      }, [mutate])

      const undoDelete = useCallback(async () => {
        if (!undo) return
        const restored = await mutate({ op: 'restore', task: undo.task })
        if (restored) setUndo(null)
      }, [mutate, undo])

      // The undo offer disappears on its own so a stale banner cannot linger.
      useEffect(() => {
        if (!undo) return undefined
        const timer = window.setTimeout(() => setUndo(null), 8000)
        return () => window.clearTimeout(timer)
      }, [undo])

      const clearDoneNow = useCallback(async ids => {
        if (!Array.isArray(ids) || ids.length === 0) return
        const ok = await mutate({ op: 'clearDone', ids })
        if (ok) setConfirmClear(false)
      }, [mutate])

      const recordFocus = useCallback(async (taskId, seconds) => {
        if (!taskId || !(seconds > 0)) return
        try {
          const payload = await apiPost('/mutate', { op: 'focus', id: taskId, seconds })
          applyState(payload)
        } catch {
          // Losing a focus record must not disturb the page.
        }
      }, [applyState])

      useEffect(() => {
        refresh()
        const clock = window.setInterval(() => setNow(Date.now()), 30000)
        // With cloud sync on, poll faster so another machine's edits show up soon.
        const poll = window.setInterval(() => refresh(), syncEnabled ? 10000 : 60000)
        return () => {
          window.clearInterval(clock)
          window.clearInterval(poll)
          leaveFullscreen()
        }
      }, [refresh, syncEnabled])

      // Midnight roll: a page that was showing "today" follows the calendar.
      const todayStartRef = useRef(startOfDay(new Date()).getTime())
      useEffect(() => {
        const todayStart = startOfDay(new Date(now)).getTime()
        if (todayStart === todayStartRef.current) return
        const wasViewingToday = sameDay(day, new Date(todayStartRef.current))
        todayStartRef.current = todayStart
        if (wasViewingToday) setDay(startOfDay(new Date()))
      }, [now, day])

      // Due reminders while the panel is open: chime, toast, and a system
      // notification when the browser granted it.
      useEffect(() => {
        try {
          window.localStorage.setItem(REMIND_KEY, remindOn ? '1' : '0')
        } catch {
          // preferences are best effort
        }
      }, [remindOn])

      useEffect(() => {
        if (!remindOn) return undefined
        const tick = () => {          const stamp = Date.now()
          for (const task of tasks) {
            if (task.done || !task.due || notifiedRef.current.has(task.id)) continue
            const due = new Date(task.due).getTime()
            if (!Number.isFinite(due)) continue
            if (due > stamp || stamp - due > 10 * 60 * 1000) continue
            notifiedRef.current.add(task.id)
            chime()
            const message = fill(t('remind.due'), { title: task.title })
            showToast(message, 'warn')
            try {
              if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(t('panel.title'), { body: message, tag: task.id })
              }
            } catch {
              // A refused notification must not disturb the page.
            }
          }
        }
        tick()
        const timer = window.setInterval(tick, 15000)
        return () => window.clearInterval(timer)
      }, [remindOn, tasks, showToast, t])

      const toggleRemind = useCallback(() => {
        setRemindOn(current => {
          const next = !current
          if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
            try {
              const pending = Notification.requestPermission()
              if (pending && typeof pending.catch === 'function') pending.catch(() => {})
            } catch {
              // Permission is optional; the in-app toast still works.
            }
          }
          return next
        })
      }, [])

      // The daily quote is fetched from the host (which caches one per day);
      // the built-in line is the fallback when the network is unavailable.
      useEffect(() => {
        let cancelled = false
        const load = async () => {
          try {
            const payload = await apiGet('/quote')
            if (!cancelled && payload && typeof payload.text === 'string' && payload.text) setQuote(payload)
          } catch {
            // The network quote is optional; the local daily line still shows.
          }
        }
        load()
        const timer = window.setInterval(load, 30 * 60 * 1000)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [])

      const refreshQuote = useCallback(async () => {
        try {
          const payload = await apiGet('/quote?refresh=1')
          if (payload && typeof payload.text === 'string' && payload.text) setQuote(payload)
          else showToast(t('quote.stale'), 'warn')
        } catch {
          showToast(t('quote.stale'), 'warn')
        }
      }, [showToast, t])

      useEffect(() => {
        setDraft(current => ({ ...current, date: localDateValue(day) }))
      }, [day])

      useEffect(() => {
        try {
          window.localStorage.setItem(PREF_KEY, JSON.stringify({ minutes }))
        } catch {
          // preferences are best effort
        }
      }, [minutes])

      // Tick the countdown off the wall clock so a throttled tab cannot drift.
      useEffect(() => {
        if (!focus || !focus.running || !focus.deadline) return undefined
        const timer = window.setInterval(() => {
          setFocus(current => {
            if (!current || !current.running || !current.deadline) return current
            const remaining = Math.max(0, (current.deadline - Date.now()) / 1000)
            if (remaining <= 0) return { ...current, remaining: 0, running: false, deadline: null, finished: true }
            return { ...current, remaining }
          })
        }, 250)
        return () => window.clearInterval(timer)
      }, [focus && focus.running, focus && focus.deadline])

      useEffect(() => {
        if (!focus || !focus.finished || finishedRef.current) return
        finishedRef.current = true
        chime()
        recordFocus(focus.taskId, Math.round(focus.duration))
      }, [focus && focus.finished, focus && focus.taskId, recordFocus])

      // "Again" restarts an unfinished countdown, so its next finish records too.
      useEffect(() => {
        if (focus && !focus.finished) finishedRef.current = false
      }, [focus && focus.finished])

      const closeFocus = useCallback(recordElapsed => {
        if (focus && recordElapsed) {
          const elapsed = focus.finished ? 0 : Math.max(0, focus.duration - focus.remaining)
          if (elapsed >= 45) recordFocus(focus.taskId, Math.round(elapsed))
        }
        finishedRef.current = false
        setFocus(null)
        setPresetReset(null)
        leaveFullscreen()
      }, [focus, recordFocus])

      const startFocus = useCallback(task => {
        enterFullscreen()
        finishedRef.current = false
        setFocus({
          taskId: task.id,
          title: task.title,
          duration: minutes * MINUTE,
          remaining: minutes * MINUTE,
          deadline: Date.now() + minutes * MINUTE * 1000,
          running: true,
          finished: false,
        })
      }, [minutes])

      // Keyboard: "/" jumps to the composer and Esc leaves the focus overlay;
      // both ignore keystrokes meant for a field.
      useEffect(() => {
        const onKeyDown = event => {
          const target = event.target
          const typing = typeof Element !== 'undefined'
            && target instanceof Element
            && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
          if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            // Focus after the key event settles, otherwise the "/" lands in the
            // input that focus() just moved to.
            window.setTimeout(() => {
              if (titleRef.current) titleRef.current.focus()
            }, 0)
            return
          }
          if (event.key === 'Escape' && focus) closeFocus(true)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [focus, closeFocus])

      const pauseFocus = () => setFocus(current => {
        if (!current) return current
        if (current.running) {
          const remaining = Math.max(0, (current.deadline - Date.now()) / 1000)
          return { ...current, remaining, running: false, deadline: null }
        }
        return { ...current, running: true, deadline: Date.now() + current.remaining * 1000 }
      })

      const extendFocus = seconds => setFocus(current => {
        if (!current) return current
        const remaining = current.remaining + seconds
        return {
          ...current,
          duration: Math.max(current.duration, remaining),
          remaining,
          deadline: current.running ? Date.now() + remaining * 1000 : null,
          finished: false,
        }
      })

      /** Re-set the whole countdown to `preset` minutes, keeping pause state. */
      const restartFocus = preset => setFocus(current => {
        if (!current) return current
        const total = preset * MINUTE
        return {
          ...current,
          duration: total,
          remaining: total,
          deadline: current.running ? Date.now() + total * 1000 : null,
          finished: false,
        }
      })

      const finishTask = taskId => {
        if (taskId) mutate({ op: 'complete', id: taskId, done: true })
      }

      const finishFocus = () => {
        const taskId = focus && focus.taskId
        closeFocus(false)
        finishTask(taskId)
      }

      const sections = useMemo(() => {
        const dayStart = startOfDay(day)
        const dayEnd = addDays(dayStart, 1)
        const groups = { overdue: [], earlier: [], am: [], pm: [], eve: [], allDay: [], later: [], someday: [] }
        for (const task of tasks) {
          if (task.done) continue
          // "Overdue" means past now in every day view, so a task can never be
          // counted as late and shown as not-late on the same screen.
          if (isOverdue(task, now)) {
            groups.overdue.push(task)
            continue
          }
          if (!task.due) {
            groups.someday.push(task)
            continue
          }
          const due = new Date(task.due)
          if (due < dayStart) groups.earlier.push(task)
          else if (due >= dayEnd) groups.later.push(task)
          else if (task.allDay) groups.allDay.push(task)
          else {
            const hour = due.getHours()
            if (hour < 12) groups.am.push(task)
            else if (hour < 18) groups.pm.push(task)
            else groups.eve.push(task)
          }
        }
        const byDue = (a, b) => new Date(a.due).getTime() - new Date(b.due).getTime()
        for (const key of ['overdue', 'earlier', 'am', 'pm', 'eve', 'allDay', 'later']) groups[key].sort(byDue)
        groups.someday.sort((a, b) => a.createdAt - b.createdAt)
        const labels = {
          overdue: t('group.overdue'),
          earlier: t('group.before'),
          am: t('group.am'),
          pm: t('group.pm'),
          eve: t('group.eve'),
          allDay: t('group.allDay'),
          later: t('group.later'),
          someday: t('group.someday'),
        }
        return Object.keys(groups)
          .filter(key => groups[key].length > 0)
          .map(key => ({ key, title: labels[key], tone: key === 'overdue' ? 'danger' : undefined, items: groups[key] }))
      }, [tasks, day, now, t])

      // The finished list belongs to the viewed day: tasks due that day, plus
      // untimed ones when today is shown.
      const doneTasks = useMemo(() => {
        const dayStart = startOfDay(day)
        const dayEnd = addDays(dayStart, 1)
        return tasks
          .filter(task => task.done && (!task.due
            ? sameDay(day, new Date(now))
            : new Date(task.due) >= dayStart && new Date(task.due) < dayEnd))
          .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
          .slice(0, 60)
      }, [tasks, day, now])

      const isToday = sameDay(day, new Date(now))
      // Counts describe exactly the list below, so the numbers can never
      // disagree with the groups on screen.
      const shownOpen = tasks.filter(task => !task.done).length
      const shownDone = doneTasks.length
      const totalShown = shownOpen + shownDone
      const progress = totalShown > 0 ? Math.round((shownDone / totalShown) * 100) : 0

      // Completed history: the same time window is used for the table and for
      // the export request, so the file always matches what is on screen.
      const historyBounds = (() => {
        if (historyRange === 'custom') {
          const start = customFrom ? startOfDay(new Date(`${customFrom}T00:00:00`)).getTime() : 0
          const end = customTo ? addDays(startOfDay(new Date(`${customTo}T00:00:00`)), 1).getTime() : Number.MAX_SAFE_INTEGER
          const from = Number.isFinite(start) ? start : 0
          const to = Number.isFinite(end) ? end : Number.MAX_SAFE_INTEGER
          // A reversed pair still means "between these two days".
          return from <= to ? { from, to } : { from: to, to: from }
        }
        if (historyRange === '7d') return { from: now - 7 * DAY, to: now + 1 }
        if (historyRange === '30d') return { from: now - 30 * DAY, to: now + 1 }
        return { from: 0, to: Number.MAX_SAFE_INTEGER }
      })()
      const historyRows = completedBetween(tasks, historyBounds.from, historyBounds.to)

      const exportFile = useCallback(async format => {
        try {
          const href = await API(`/export?format=${format}&lang=${IS_ZH ? 'zh' : 'en'}`
            + `&from=${historyBounds.from}&to=${historyBounds.to}`)
          const anchor = document.createElement('a')
          anchor.href = href
          anchor.rel = 'noopener'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          showToast(t('history.exported'))
        } catch (failure) {
          showToast(failure.message, 'error')
        }
      }, [historyBounds.from, historyBounds.to, showToast, t])

      const submitDraft = async () => {
        const title = draft.title.trim()
        if (!title) {
          showToast(t('error.title'), 'warn')
          return
        }
        const due = composeDue(draft.date, draft.time)
        const ok = await mutate({
          op: 'create',
          title,
          note: draft.note,
          due: due ? due.toISOString() : null,
          allDay: Boolean(due) && !draft.time,
          priority: draft.priority,
          repeat: draft.repeat,
        })
        if (ok) setDraft(current => ({ ...current, title: '', note: '', repeat: 'none', noteOpen: false }))
      }

      const saveEditing = async () => {
        if (!editing) return
        const title = editing.title.trim()
        if (!title) {
          showToast(t('error.title'), 'warn')
          return
        }
        const due = composeDue(editing.date, editing.time)
        const ok = await mutate({
          op: 'update',
          id: editing.id,
          title,
          note: editing.note,
          due: due ? due.toISOString() : null,
          allDay: Boolean(due) && !editing.time,
          priority: editing.priority,
          repeat: editing.repeat,
        })
        if (ok) setEditing(null)
      }

      // Urgency ordering: one flat list, most urgent first, independent of the
      // day grouping used by the time view.
      const urgentTasks = useMemo(() => tasks
        .filter(task => !task.done)
        .sort((a, b) => urgencyScore(b, now) - urgencyScore(a, now)
          || (a.due ? new Date(a.due).getTime() : Number.MAX_SAFE_INTEGER)
          - (b.due ? new Date(b.due).getTime() : Number.MAX_SAFE_INTEGER)
          || a.createdAt - b.createdAt), [tasks, now])

      // A small daily line that changes with the calendar day.
      const dayOfYear = Math.floor((startOfDay(day).getTime() - new Date(day.getFullYear(), 0, 1).getTime()) / DAY)
      const quoteIndex = ((dayOfYear % 8) + 8) % 8 + 1
      const remoteQuote = quote && typeof quote.text === 'string' && quote.text ? quote : null
      const quoteText = remoteQuote ? remoteQuote.text : t(`quote.${quoteIndex}`)
      const quoteFrom = remoteQuote && remoteQuote.from ? remoteQuote.from : ''

      const rowProps = task => ({
        key: task.id, task, now, t, busy, editing, setEditing,
        showUrgency: sortMode === 'urgency',
        onToggle: async () => {
          const becomingDone = !task.done
          const payload = await mutate({ op: 'complete', id: task.id, done: becomingDone })
          if (payload && becomingDone) celebrate(payload.tasks)
        },
        onStart: () => startFocus(task),
        onDelete: () => deleteTask(task),
        onSave: saveEditing,
      })

      // Date context appears once: the title for another day, the navigation row
      // for today; the subtitle only explains the ordering.
      const heading = view === 'history'
        ? t('history.title')
        : isToday ? t('hero.title') : `${monthDayFormat.format(day)} ${weekdayFormat.format(day)}`
      const subtitle = view === 'history' ? t('history.sub') : t('hero.sub')

      const syncConfigured = Boolean(sync && (sync.enabled || sync.configured || sync.configError))
      const syncFailed = Boolean(sync && (sync.lastError || (sync.configError && !sync.enabled)))
      const syncText = syncBusy
        ? `⟳ ${t('sync.busy')}`
        : sync && sync.configError && !sync.enabled
          ? `☁ ${t('sync.unconfigured')}`
          : sync && sync.lastError
            ? `☁ ${t('sync.error')}`
            : sync && sync.lastOkAt
              ? `☁ ${fill(t('sync.last'), { ago: agoText(t, sync.lastOkAt) })}`
              : `☁ ${t('sync.never')}`
      const syncTitle = (sync && (sync.lastError || sync.configError))
        || (sync && sync.target ? `${t('sync.title')} · ${sync.target}` : t('sync.title'))

      const historyNode = [
        h('div', { key: 'tools', className: 'dp-history-tools' },
          h('div', { className: 'dp-quick' },
            [['all', t('history.all')], ['7d', t('history.week')], ['30d', t('history.month')]].map(([value, label]) =>
              h('button', {
                key: value, 'data-active': String(historyRange === value),
                onClick: () => setHistoryRange(value),
              }, label)),
            h('button', {
              key: 'custom', 'data-active': String(historyRange === 'custom'),
              onClick: () => {
                setHistoryRange('custom')
                if (!customFrom && !customTo) {
                  const today = localDateValue(new Date())
                  setCustomFrom(today)
                  setCustomTo(today)
                }
              },
            }, t('history.custom'))),
          historyRange === 'custom'
            ? h('span', { className: 'dp-history-dates' },
              h('input', {
                className: 'dp-input', type: 'date', value: customFrom, 'aria-label': t('history.from'),
                onChange: event => setCustomFrom(event.target.value),
              }),
              h('span', null, t('history.rangeSep')),
              h('input', {
                className: 'dp-input', type: 'date', value: customTo, 'aria-label': t('history.to'),
                onChange: event => setCustomTo(event.target.value),
              }))
            : null,
          h('span', { className: 'dp-spacer' }),
          h('span', { className: 'dp-daynav-hint' }, fill(t('history.count'), { n: historyRows.length })),
          h('button', { className: 'dp-btn', 'data-quiet': 'true', onClick: () => exportFile('markdown') }, t('history.exportMd')),
          h('button', { className: 'dp-btn', 'data-primary': 'true', onClick: () => exportFile('xlsx') }, t('history.exportXlsx'))),
        historyRows.length === 0
          ? h('div', { key: 'empty', className: 'dp-history-empty' },
            h('div', { className: 'dp-empty-title' }, t('history.empty')),
            h('div', null, t('history.emptyHint')))
          : h('div', { key: 'table', className: 'dp-history-scroll' },
            h('table', { className: 'dp-history-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('history.colTime')),
                h('th', null, t('history.colTask')),
                h('th', null, t('history.colNote')),
                h('th', null, t('history.colDue')))),
              h('tbody', null, historyRows.map(task => h('tr', { key: task.id },
                h('td', { className: 'dp-history-time' }, stampText(task.completedAt)),
                h('td', { className: 'dp-history-task' }, task.title),
                h('td', { className: 'dp-history-note' }, task.note || ''),
                h('td', { className: 'dp-history-time' }, task.due ? stampText(Date.parse(task.due)) : '')))))),
      ]

      const focusNode = focus
        ? h('div', { className: 'dp-focus', 'data-finished': String(focus.finished), role: 'dialog', 'aria-label': t('focus.title') },
          h('div', { className: 'dp-focus-kicker' }, focus.finished ? t('focus.finished') : t('focus.doing')),
          h('div', { className: 'dp-focus-task' }, focus.title),
          h('div', { className: 'dp-ring' },
            h(FocusRing, { remaining: focus.remaining, duration: focus.duration }),
            h('div', { className: 'dp-ring-inner' },
              h('div', { className: 'dp-ring-time' }, formatClock(focus.remaining)),
              h('div', { className: 'dp-ring-total' }, fill(t('focus.total'), { n: Math.round(focus.duration / MINUTE) })))),
          h('div', { className: 'dp-focus-actions' },
            focus.finished
              ? [
                h('button', { key: 'finish', className: 'dp-focus-btn', 'data-primary': 'true', onClick: finishFocus }, t('focus.finish')),
                h('button', { key: 'again', className: 'dp-focus-btn', onClick: () => extendFocus(5 * MINUTE) }, t('focus.again')),
                h('button', { key: 'exit', className: 'dp-focus-btn', onClick: () => closeFocus(false) }, t('focus.exit')),
              ]
              : [
                h('button', { key: 'toggle', className: 'dp-focus-btn', 'data-primary': 'true', onClick: pauseFocus }, focus.running ? t('focus.pause') : t('focus.resume')),
                h('button', { key: 'more', className: 'dp-focus-btn', onClick: () => extendFocus(5 * MINUTE) }, '+5'),
                h('button', { key: 'finish', className: 'dp-focus-btn', onClick: finishFocus }, t('focus.finish')),
                h('button', { key: 'exit', className: 'dp-focus-btn', onClick: () => closeFocus(true) }, t('focus.exit')),
              ]),
          h('div', { className: 'dp-focus-presets' },
            h('span', null, t('focus.duration')),
            FOCUS_PRESETS.map(preset => h('button', {
              key: preset, 'data-active': String(preset === minutes),
              onClick: () => {
                // Changing the preset mid-session resets the countdown, so ask
                // instead of silently throwing away the elapsed time.
                if (focus && !focus.finished && focus.duration - focus.remaining > 2) setPresetReset(preset)
                else {
                  setMinutes(preset)
                  restartFocus(preset)
                }
              },
            }, fill(t('focus.minutes'), { n: preset })))),
          presetReset !== null
            ? h('div', { className: 'dp-focus-reset' },
              h('span', null, t('focus.resetConfirm')),
              h('button', {
                className: 'dp-focus-btn', 'data-primary': 'true',
                onClick: () => {
                  setMinutes(presetReset)
                  restartFocus(presetReset)
                  setPresetReset(null)
                },
              }, t('focus.resetYes')),
              h('button', { className: 'dp-focus-btn', onClick: () => setPresetReset(null) }, t('focus.resetNo')))
            : null,
          h('div', { className: 'dp-focus-hint' }, t('focus.hint')))
        : null

      return h('div', { className: 'dp-page' },
        h('style', null, STYLES),
        h('div', { className: 'dp-shell' },
          h('div', { className: 'dp-surface' },
            h('div', { className: 'dp-hero' },
              h('div', null,
                h('div', { className: 'dp-hero-title' }, heading),
                h('div', { className: 'dp-hero-sub' }, subtitle)),
              h('div', { className: 'dp-stats' },
                h('div', { className: 'dp-stat' },
                  h('div', { className: 'dp-stat-num' }, String(shownOpen)),
                  h('div', { className: 'dp-stat-label' }, t('hero.open'))),
                h('div', { className: 'dp-stat' },
                  h('div', { className: 'dp-stat-num', 'data-tone': 'done' }, String(shownDone)),
                  h('div', { className: 'dp-stat-label' }, t('hero.done'))))),
            h('div', { className: 'dp-tabs' },
              h('button', { className: 'dp-tab', 'data-active': String(view === 'plan'), onClick: () => setView('plan') }, t('view.plan')),
              h('button', { className: 'dp-tab', 'data-active': String(view === 'history'), onClick: () => setView('history') }, t('view.history'))),
            h('div', { className: 'dp-body' },
            h('div', { className: 'dp-plan', style: { display: view === 'plan' ? undefined : 'none' } },
            h('div', { className: 'dp-progress' }, h('span', { style: { width: `${progress}%` } })),
            h('div', { className: 'dp-daynav' },
              h('button', { className: 'dp-icon-btn', onClick: () => setDay(current => addDays(current, -1)), title: t('nav.prev'), 'aria-label': t('nav.prev') }, '‹'),
              h('button', { className: 'dp-icon-btn', onClick: () => setDay(current => addDays(current, 1)), title: t('nav.next'), 'aria-label': t('nav.next') }, '›'),
              isToday
                ? h('div', { className: 'dp-daynav-label' }, `${monthDayFormat.format(day)} ${weekdayFormat.format(day)}`)
                : null,
              h('span', { className: 'dp-spacer' }),
              h('span', { className: 'dp-sort' },
                h('button', {
                  className: 'dp-sort-btn', 'data-active': String(sortMode === 'time'),
                  onClick: () => setSortMode('time'),
                }, t('sort.time')),
                h('button', {
                  className: 'dp-sort-btn', 'data-active': String(sortMode === 'urgency'),
                  onClick: () => setSortMode('urgency'),
                }, t('sort.urgency'))),
              isToday
                ? null
                : h('button', { className: 'dp-link', onClick: () => setDay(startOfDay(new Date())), title: t('nav.today') }, t('nav.today'))),
            h('div', { className: 'dp-compose' },
              h('div', { className: 'dp-compose-top' },
                h('input', {
                  className: 'dp-input', ref: titleRef, value: draft.title,
                  placeholder: t('add.placeholder'), 'aria-label': t('add.placeholder'),
                  title: t('shortcut.hint'),
                  onChange: event => setDraft({ ...draft, title: event.target.value }),
                  onKeyDown: event => { if (event.key === 'Enter') submitDraft() },
                }),
                h('button', { className: 'dp-btn', 'data-primary': 'true', onClick: submitDraft, disabled: busy || !draft.title.trim() }, t('add.button'))),
              h('div', { className: 'dp-compose-row' },
                h('input', {
                  className: 'dp-input', type: 'date', value: draft.date, 'aria-label': t('add.date'),
                  style: { flex: '0 1 140px' },
                  onChange: event => setDraft({ ...draft, date: event.target.value }),
                }),
                h('input', {
                  className: 'dp-input', type: 'time', value: draft.time, 'aria-label': t('add.time'),
                  style: { flex: '0 1 110px' },
                  onChange: event => setDraft({ ...draft, time: event.target.value }),
                }),
                h('div', { className: 'dp-quick' },
                  [[t('add.quickToday'), 0], [t('add.quickTomorrow'), 1], [t('add.quickDayAfter'), 2]].map(([label, offset]) =>
                    h('button', {
                      key: label,
                      onClick: () => setDraft(current => ({ ...current, date: localDateValue(addDays(startOfDay(new Date()), offset)) })),
                    }, label))),
                h('select', {
                  className: 'dp-select', value: draft.priority, 'aria-label': t('add.priority'),
                  style: { padding: '4px 6px', fontSize: '12px' },
                  onChange: event => setDraft({ ...draft, priority: event.target.value }),
                }, ['normal', 'high', 'low'].map(level => h('option', { key: level, value: level }, t(`priority.${level}`)))),
                h('select', {
                  className: 'dp-select', value: draft.repeat, 'aria-label': t('repeat.label'),
                  style: { padding: '4px 6px', fontSize: '12px' },
                  onChange: event => setDraft({ ...draft, repeat: event.target.value }),
                }, REPEAT_VALUES.map(value => h('option', { key: value, value }, t(`repeat.${value}`)))),
                h('button', {
                  className: 'dp-btn dp-note-btn dp-toggle', 'data-quiet': 'true', 'data-active': String(draft.noteOpen),
                  'aria-expanded': String(draft.noteOpen),
                  onClick: () => setDraft({ ...draft, noteOpen: !draft.noteOpen }),
                  title: t('add.note'),
                }, t('add.note')),
                h('span', { className: 'dp-spacer' }),
                h('span', null, t('add.hint'))),
              draft.noteOpen
                ? h('textarea', {
                  className: 'dp-input dp-note-input', value: draft.note, rows: 2,
                  placeholder: t('add.notePlaceholder'), 'aria-label': t('add.note'),
                  onChange: event => setDraft({ ...draft, note: event.target.value }),
                })
                : null),
            error
              ? h('div', { className: 'dp-error' }, `${t('error.load')}：${error}`,
                h('button', { className: 'dp-btn', 'data-quiet': 'true', onClick: refresh }, t('error.retry')))
              : null,
            warning ? h('div', { className: 'dp-warn' }, warning) : null,
            undo
              ? h('div', { className: 'dp-undo', role: 'status' },
                h('span', null, fill(t('undo.deleted'), { title: undo.task.title })),
                h('span', { className: 'dp-spacer' }),
                h('button', { className: 'dp-btn', 'data-primary': 'true', onClick: undoDelete }, t('undo.button')))
              : null,
            confirmClear && doneTasks.length > 0
              ? h('div', { className: 'dp-undo', role: 'alertdialog' },
                h('span', null, fill(t('clear.confirm'), { n: doneTasks.length })),
                h('span', { className: 'dp-spacer' }),
                h('button', { className: 'dp-btn', 'data-danger': 'true', onClick: () => clearDoneNow(doneTasks.map(task => task.id)) }, t('clear.yes')),
                h('button', { className: 'dp-btn', 'data-quiet': 'true', onClick: () => setConfirmClear(false) }, t('clear.cancel')))
              : null,
            !loaded
              ? h('div', { className: 'dp-loading' }, t('loading'))
              : null,
            loaded && sections.length === 0 && doneTasks.length === 0
              ? h('div', { className: 'dp-empty' },
                h('div', { className: 'dp-empty-title' }, t('empty.title')),
                h('div', null, t('empty.hint')))
              : null,
            loaded && sortMode === 'urgency'
              ? h('div', { className: 'dp-section' },
                h('div', { className: 'dp-group' },
                  t('sort.urgency'),
                  h('span', { className: 'dp-group-count' }, String(urgentTasks.length))),
                urgentTasks.length === 0
                  ? null
                  : h('div', { className: 'dp-rows' }, urgentTasks.map(task => h(TaskRow, rowProps(task)))))
              : null,
            loaded && sortMode === 'time'
              ? sections.map(section => h('div', { key: section.key, className: 'dp-section' },
                h('div', { className: 'dp-group', 'data-tone': section.tone },
                  section.title,
                  h('span', { className: 'dp-group-count' }, String(section.items.length))),
                h('div', { className: 'dp-rows' }, section.items.map(task => h(TaskRow, rowProps(task))))))
              : null,
            loaded && doneTasks.length > 0
              ? h('div', { className: 'dp-section' },
                h('button', { className: 'dp-done-toggle', onClick: () => setShowDone(value => !value) },
                  `${showDone ? '▾' : '▸'} ${t('group.done')} · ${doneTasks.length}`),
                showDone ? h('div', { className: 'dp-rows' }, doneTasks.map(task => h(TaskRow, rowProps(task)))) : null)
              : null),
            h('div', { className: 'dp-history', style: { display: view === 'history' ? undefined : 'none' } }, historyNode)),
            h('div', { className: 'dp-foot' },
              h('span', null, view === 'history'
                ? fill(t('history.count'), { n: historyRows.length })
                : fill(t('status.count'), { open: shownOpen, done: shownDone })),
              h('span', { className: 'dp-spacer' }),
              h('button', {
                className: 'dp-btn dp-toggle', 'data-quiet': 'true', 'data-active': String(remindOn),
                'aria-pressed': String(remindOn), title: remindOn ? t('remind.on') : t('remind.off'),
                onClick: toggleRemind,
              }, `${remindOn ? '🔔' : '🔕'} ${t('remind.toggle')}`),
              syncConfigured
                ? h('button', {
                  className: 'dp-sync',
                  'data-tone': syncFailed ? 'error' : undefined,
                  title: syncTitle,
                  'aria-label': t('sync.now'),
                  onClick: syncNow,
                  disabled: syncBusy,
                }, syncText)
                : null,
              doneTasks.length > 0 && !confirmClear
                ? h('button', { className: 'dp-btn', 'data-quiet': 'true', onClick: () => setConfirmClear(true) }, t('status.clearDone'))
                : null),
            h('div', { className: 'dp-quote-bar' },
              h('span', { className: 'dp-quote-mark', 'aria-hidden': 'true' }, '“'),
              h('span', { className: 'dp-quote-text' }, quoteText),
              quoteFrom ? h('span', { className: 'dp-quote-from' }, `— ${quoteFrom}`) : null,
              remoteQuote && remoteQuote.kind
                ? h('span', { className: 'dp-quote-kind' }, t(`quote.kind.${remoteQuote.kind}`))
                : null,
              h('button', {
                className: 'dp-btn', 'data-quiet': 'true',
                onClick: refreshQuote, title: t('quote.refresh'), 'aria-label': t('quote.refresh'),
              }, '↻'),
              remoteQuote && remoteQuote.stale
                ? h('span', { className: 'dp-quote-from' }, t('quote.stale'))
                : null))),
        toast
          ? h('div', { className: 'dp-toast', 'data-tone': toast.tone === 'info' ? undefined : toast.tone, role: 'status', 'aria-live': 'polite' },
            h('span', null, toast.text),
            h('button', { className: 'dp-toast-close', onClick: () => setToast(null), 'aria-label': t('toast.close') }, '×'))
          : null,
        focusNode && createPortal ? createPortal(focusNode, document.body) : focusNode)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'daily-plan: dictionaries')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 25,
          label: () => t('panel.title'),
        }, PanelIcon)), 'daily-plan: sidebar entry')
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, DailyPage)), 'daily-plan: main panel')
      },
    }
  },
})
