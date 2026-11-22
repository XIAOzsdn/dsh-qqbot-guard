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
});

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
  },

  join: {
    autoApprove: false,
    /** 命中风险提示时自动拒绝 */
    autoDeclineRisk: true,
    /** 验证消息包含这些词 → 通过（autoApprove 开启时生效） */
    approveKeywords: [],
    /** 验证消息包含这些词 → 拒绝 */
    declineKeywords: [],
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
  },

  announcements: {
    enabled: true,
    /** 新建公告时默认勾选的群 openid 列表 */
    defaultTargets: [],
  },

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
  risk: 0.9,
  manual: 1,
});
