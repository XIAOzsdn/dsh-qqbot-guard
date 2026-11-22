/**
 * 全部可调参数集中在这里（规则：可变参数必须外移，杜绝魔数）。
 * 代码里只允许引用本文件导出的常量 / DEFAULT_SETTINGS 字段。
 */

/** 运行时硬上限（防止内存无限增长，属于工程常量而非业务魔数）。 */
export const LIMITS = Object.freeze({
  /** 成员台账最多保留人数 */
  members: 5000,
  /** 每写入多少次成员后做一次超限裁剪（避免每条消息都全量排序） */
  memberPruneEvery: 100,
  /** 每个群的待审批申请最多保留条数 */
  pendingPerGroup: 200,
  /** 已处理申请的保留时长（用于事件去重） */
  pendingDoneTtlMs: 24 * 3600_000,
  /** 违规计数最多保留用户数 */
  violationUsers: 2000,
  /** 每个用户保留的违规时间戳条数 */
  violationEventsPerUser: 30,
  /** 审计日志内存条数 */
  auditMemory: 300,
  /** 审计文件单文件最大字节数，超过后轮转为 .1 */
  auditFileBytes: 2 * 1024 * 1024,
  /** 公告历史最多保留条数 */
  announcementHistory: 200,
  /** 面板一次最多返回的成员数 */
  memberSearchLimit: 100,
  /** 主动消息最小发送间隔（毫秒），避免触发频控 */
  sendGapMs: 350,
  /** 公告调度扫描间隔（毫秒） */
  schedulerTickMs: 30_000,
  /** 单个群一次公告发送最多重试次数 */
  announceRetries: 1,
  /** HTTP 请求体最大字节数 */
  httpBodyBytes: 1024 * 1024,
  /** 自动重连退避上限（毫秒） */
  reconnectMaxMs: 5 * 60_000,
  /** 自动重连退避初始值（毫秒） */
  reconnectMinMs: 5_000,
  /** 日志文件最多保留的字符串长度（防止超长内容写爆磁盘） */
  auditTextMax: 500,
  /** 状态文件合并写入间隔（毫秒），避免每条消息都写盘 */
  stateFlushMs: 5_000,
  /** 单次 QQ REST 请求超时（毫秒） */
  apiTimeoutMs: 15_000,
  /** token 提前刷新窗口（毫秒） */
  tokenRefreshAheadMs: 30_000,
  /** 熔断阈值（连续失败次数） */
  breakerThreshold: 5,
  /** 熔断冷却时间（毫秒） */
  breakerCooldownMs: 60_000,
  /** 单条群消息最大字符数（官方上限 4500，留出安全余量） */
  messageMaxChars: 4500,
  /** 公告正文最大字符数 */
  announcementMaxChars: 4000,
  /** 公告标题最大字符数 */
  titleMaxChars: 100,
  /** 警告文案最大字符数 */
  warnMaxChars: 1000,
  /** 群名称最大字符数 */
  groupNameMaxChars: 100,
  /** 审计详情里引用的公告片段长度 */
  auditSnippetChars: 80,
  /** 审批拒绝原因最大字符数 */
  reasonMaxChars: 200,
  /** 兼容性页面“网络探测”超时（毫秒） */
  networkProbeTimeoutMs: 5_000,
  /** 黑名单最多保留条数 */
  blacklistMax: 5000,
  /** 同时进行中的入群答题最多人数 */
  quizMax: 500,
  /** 入群答题最长等待（秒） */
  quizMaxTimeoutSec: 3600,
  /** 独立面板默认端口 */
  panelDefaultPort: 8790,
  /** 面板会话清理间隔（毫秒） */
  sessionSweepMs: 5 * 60_000,
  /** 登录失败窗口（毫秒） */
  loginWindowMs: 10 * 60_000,
  /** 窗口内允许的登录失败次数 */
  loginMaxFails: 5,
  /** 登录失败后的锁定时间（毫秒） */
  loginLockMs: 10 * 60_000,
  /** 面板单次请求体上限（字节） */
  panelBodyBytes: 2 * 1024 * 1024,
  /** 群通知改动日志最大字符数 */
  notifyMaxChars: 1500,
  /** 单次设置变更通知最多触发的群数 */
  notifyMaxGroups: 50,
  /** 面板密码最短长度 */
  passwordMin: 8,
  /** 面板密码最长长度 */
  passwordMax: 64,
});

/** 图片广告常见词：图片 + 这些词时判定为广告二维码嫌疑 */
export const MEDIA_AD_KEYWORDS = Object.freeze([
  '扫码', '二维码', '加微信', '加微', '加我', '兼职', '刷单', '返利', '代理',
  '福利', '领红包', '投资', '博彩', '私聊', '看主页', '日赚', '招人',
]);

/** 模糊匹配别名表：命中别名后按 canonical 视为命中违规词 */
export const FUZZY_ALIASES = Object.freeze([
  { canonical: '傻逼', aliases: ['傻b', '傻比', '沙比', '煞笔', '傻批', 'shabi', 'sb'] },
  { canonical: '智障', aliases: ['制杖', '治障', '智章'] },
  { canonical: '脑残', aliases: ['恼残', '脑can'] },
  { canonical: '弱智', aliases: ['若智', '弱制'] },
  { canonical: '操你妈', aliases: ['草泥马', '艹你妈', 'caonima', 'cnm'] },
  { canonical: '去死', aliases: ['去4'] },
  { canonical: '贱人', aliases: ['溅人'] },
  { canonical: '狗东西', aliases: ['狗东c'] },
]);

/** 默认配置：面板里能改的所有字段都在这里。 */
export const DEFAULT_SETTINGS = Object.freeze({
  appId: '',
  appSecret: '',
  autoConnect: true,
  watchJoinRequests: true,
  /** 面板显示的群注册表刷新间隔（仅按需刷新，不轮询） */
  groupInfoTtlMs: 10 * 60_000,

  moderation: {
    enabled: true,
    /** warn | mute | kick；实际执行失败时会按 warn → mute → kick 的降级链兜底 */
    action: 'warn',
    muteSeconds: 600,
    /** 同一用户两次处置的最小间隔，防刷屏 */
    cooldownSec: 60,
    /** 警告文案，支持 {user} / {group} / {rule} */
    warnTemplate: '{user} 请注意言辞：群内禁止辱骂、人身攻击和恶意刷屏。',
    keywords: [
      '傻逼', '傻子', '蠢货', '蠢猪', '脑残', '弱智', '智障', '贱人', '狗东西', '狗杂种',
      '王八蛋', '混蛋', '滚蛋', '去死', '你妈死了', '操你妈', '草泥马', '尼玛', '妈的',
      'nmsl', 'tmd', 'cnm', 'fk you', 'fuck you', 'sb东西',
    ],
    /** 正则规则（字符串形式，面板可编辑；编译失败会被忽略并记入审计） */
    regexes: [],
    /** 默认忽略 @、表情标签等噪声后再匹配 */
    detectLinks: false,
    linkWhitelist: ['qq.com', 'tencent.com', 'gov.cn'],
    spam: {
      enabled: true,
      /** 统计窗口（秒） */
      windowSec: 10,
      /** 窗口内达到该条数判定刷屏 */
      maxMessages: 6,
    },
    escalation: {
      enabled: true,
      /** 统计窗口内第几次违规升级 */
      violations: 3,
      windowHours: 24,
      /** 升级后的动作 */
      action: 'kick',
    },
    /** 这些群不执行自动处置（仍记录审计） */
    exemptGroups: [],
    /** 信任成员（豁免处置，同时允许使用群指令）：[{uid, name, note}] */
    trustedUsers: [],
    /** 模糊匹配：去分隔符 + 常见别名，降低拆字绕过 */
    fuzzy: {
      enabled: true,
      /** 额外别名，每行一个，格式：别名=标准词 */
      extras: [],
    },
    /** 媒体检测：图片广告、卡片/名片 */
    media: {
      detectImages: true,
      detectCards: true,
      /** 图片消息同时命中这些词时按广告处理 */
      adKeywords: [...MEDIA_AD_KEYWORDS],
    },
    /** 违规累计黑名单 */
    blacklist: {
      enabled: true,
      /** 窗口内第 N 次违规触发 */
      threshold: 3,
      windowDays: 7,
      /** 踢出时同时加入群黑名单 */
      addToGroupBlacklist: true,
    },
  },

  join: {
    autoApprove: false,
    /** 命中风险提示时自动拒绝 */
    autoDeclineRisk: true,
    /** 验证消息包含这些词 → 通过（autoApprove 开启时生效） */
    approveKeywords: [],
    /** 验证消息包含这些词 → 拒绝 */
    declineKeywords: [],
    /** 手动拒绝申请时的默认理由 */
    rejectReason: '暂不符合入群条件',
    welcome: {
      enabled: true,
      template: '欢迎 {user} 加入本群！请先看群公告，友善交流。',
      /** 多条时按种子随机选一条（同群同人当天固定，可复现） */
      variants: [
        '欢迎 {user} 加入 {group}！请先阅读群公告，友善交流。',
        '{user} 欢迎进群～有问题可以直接在群里问，别发广告哦。',
        '欢迎新朋友 {user}！群规在公告里，违规会被处理。',
      ],
      /** 随机种子盐，换掉即可换一批欢迎语 */
      seedSalt: 'qqbot-guard',
    },
    /** 新成员观察期：默认 10 分钟，可按群覆盖 */
    observation: {
      enabled: true,
      minutes: 10,
      /** 观察期内触发时的动作：warn | mute | kick */
      action: 'mute',
      blockLinks: true,
      blockImages: true,
    },
    /** 入群答题（入群后在群里提问，答对才算完成验证） */
    quiz: {
      enabled: false,
      timeoutSec: 180,
      maxAttempts: 3,
      /** 超时或答错次数用尽后的动作：warn | mute | kick */
      action: 'kick',
      askBeforeWelcome: true,
      questions: [
        { q: '请回答：本群主要交流什么？（管理员可在面板修改本题）', a: '技术' },
      ],
    },
  },

  announcements: {
    enabled: true,
    /** 新建公告时默认勾选的群 openid 列表 */
    defaultTargets: [],
  },

  /** 群内管理员指令：/warn /mute /kick /rule /help */
  commands: {
    enabled: false,
    prefix: '/',
    /** 允许使用指令的成员 openid（不填则无人可用，防止普通成员乱操作） */
    allowUsers: [],
    ruleText: '群规：友善交流，禁止辱骂、人身攻击、广告、刷屏。违规会被警告、禁言或移出。',
  },

  /** 独立局域网 Web 面板（不依赖 dsh 设置页） */
  panel: {
    enabled: true,
    /** 0.0.0.0 = 局域网可访问；127.0.0.1 = 仅本机 */
    host: '0.0.0.0',
    port: 8790,
    /** 通知对象昵称：与 notifyOpenid 同时匹配同一位成员才 @；仅普通管理员修改时生效 */
    notifyName: '',
    /** 通知对象 QQ 号 / openid：必须与 notifyName 同时匹配；两项都空 = 只发日志 */
    notifyOpenid: '',
  },

  /** 按群覆盖：{ [gid]: { moderation?, join? } }，只写要覆盖的字段 */
  groups: {},

  /** 面板只读信息 */
  ui: {
    /** 违规防护页的说明文字 */
    notice: 'QQ 官方接口不提供“设置群公告”能力，公告由机器人以消息形式发布到群内。',
  },
});

/** 审计动作中文名（面板与日志共用） */
export const ACTION_LABEL = Object.freeze({
  warn: '警告',
  mute: '禁言',
  kick: '移出群聊',
  approve: '通过申请',
  decline: '拒绝申请',
  welcome: '入群欢迎',
  announce: '发布公告',
  config: '修改配置',
});

/** 规则 id（写入审计，方便面板解释命中了哪条） */
export const RULE_ID = Object.freeze({
  keyword: 'keyword',
  regex: 'regex',
  link: 'link',
  spam: 'spam',
  fuzzy: 'fuzzy',
  media: 'media',
  observe: 'observe',
  command: 'command',
  quiz: 'quiz',
  escalation: 'escalation',
  risk: 'risk',
  manual: 'manual',
});

/** 严重度对应的置信度（自描述元数据：下游可据此过滤/展示） */
export const CONFIDENCE = Object.freeze({
  keyword: 0.95,
  regex: 0.8,
  link: 0.75,
  spam: 0.7,
  fuzzy: 0.8,
  media: 0.7,
  observe: 0.85,
  risk: 0.9,
  manual: 1,
});
