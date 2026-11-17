import type { DomainEvent, PresentationDecision, PresentationPort, RuntimePaths } from '../../shared/contracts';

/**
 * 唯一决定「某条信息是否出现在主页面」的策略（§7.8）。
 * L0 主页面常驻 / L1 状态行一行 / L2 详情抽屉 / L3 必要打断。
 * 配置驱动，可用「详细模式」一键恢复完整信息密度。
 */
export class UiPresentationPolicy implements PresentationPort {
  private detailed = false;

  constructor(private readonly paths: RuntimePaths) {
    this.detailed = process.env.MTVC_DETAILED_MODE === 'true';
  }

  isDetailedMode(): boolean { return this.detailed; }
  setDetailedMode(enabled: boolean): void { this.detailed = enabled; }

  classify(event: DomainEvent): PresentationDecision | null {
    const stage = event.stage;
    switch (event.type) {
      case 'job.progress':
        return { level: 'L1', message: humanStage(stage), expandable: true, action: 'open-details' };
      case 'job.completed':
        return { level: 'L1', message: '完成 · 可打开所在目录', expandable: true, action: 'open-details' };
      case 'job.cancelled':
        return { level: 'L1', message: '已取消', expandable: false, action: 'none' };
      case 'job.failed':
        return { level: 'L1', message: '转换没完成，点详情看原因', expandable: true, action: 'open-details' };
      case 'lyrics.unavailable':
        return { level: 'L1', message: '未找到歌词，已生成无字幕版本', expandable: true, action: 'import-lyrics' };
      case 'lyrics.empty':
        return { level: 'L1', message: '这首歌没有歌词', expandable: true, action: 'import-lyrics' };
      case 'hardware.fallback':
        return { level: 'L1', message: '使用 CPU 模式 ⓘ', expandable: true, action: 'open-details' };
      case 'preview.fallback':
        return { level: 'L1', message: '预览已改用系统播放器', expandable: true, action: 'open-details' };
      case 'job.needsConfirmation':
        return { level: 'L3', message: '这个文件有多条音轨，用哪条当原唱？', expandable: false, action: 'choose-track' };
      case 'subtitle.burnConfirm':
        return { level: 'L3', message: '字幕会烧进画面，之后无法去除。继续吗？', expandable: false, action: 'none' };
      case 'stage.detail':
      case 'encode.backend':
      case 'compression.ratio':
      case 'accompaniment.source':
      case 'error.code':
      case 'log.entry':
      case 'validation.report':
        return this.detailed
          ? { level: 'L1', message: String(event.payload?.message ?? ''), expandable: true, action: 'open-details' }
          : { level: 'L2', message: String(event.payload?.message ?? ''), expandable: true, action: 'open-details' };
      default:
        return null;
    }
  }

  get host(): string { return this.paths.previewHost; }
}

function humanStage(stage?: DomainEvent['stage']): string {
  switch (stage) {
    case 'PROBE': return '正在读取视频…';
    case 'EXTRACT': return '正在准备原唱音轨…';
    case 'LYRICS': return '正在找歌词…';
    case 'ACCOMPANIMENT': return '正在生成伴奏…';
    case 'ALIGN': return '正在对齐伴奏…';
    case 'ENCODE_MUX': return '正在压缩视频…';
    case 'VALIDATE': return '正在检查结果…';
    default: return '正在处理…';
  }
}
