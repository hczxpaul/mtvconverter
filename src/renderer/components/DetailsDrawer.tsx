import { useEffect, useRef } from 'react';
import { STAGE_WEIGHTS, COMPRESSION_PRESETS } from '../../shared/contracts';
import type {
  BackendDecision, JobConfig, JobProgressEvent, JobRecord,
  LogEntry, StageCode, ValidationReport,
} from '../../shared/contracts';
import type { HealthResult } from '../../shared/preload-api';
import { MoreSettings } from './MoreSettings';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { Semantic } from './Semantic';

interface Props {
  open: boolean;
  tab: 'details' | 'logs' | 'settings';
  onTabChange: (t: 'details' | 'logs' | 'settings') => void;
  onClose: () => void;
  job: JobRecord | null;
  progress: JobProgressEvent | null;
  logs: LogEntry[];
  report: ValidationReport | null;
  backend: BackendDecision | null;
  fallback: BackendDecision | null;
  health: HealthResult | null;
  config: JobConfig;
  detailedMode: boolean;
  onDetailedModeChange: (v: boolean) => void;
  onPatch: (patch: Partial<JobConfig>) => void;
  onSelectAccompaniment: () => void;
  onExportLog: () => void;
  onRetryStage: (stage: StageCode) => void;
}

const CHECK_LABEL: Record<string, string> = {
  'V-01': '容器', 'V-02': '时长', 'V-03': '分辨率', 'V-04': '帧率',
  'V-05': '音视频同步', 'V-06': '画质', 'V-07': '轨道数', 'V-08': '轨道顺序',
  'V-09': '音轨切换', 'V-10': '元数据', 'V-11': '封装', 'V-12': '可播放',
  'V-13': '体积', 'V-14': '字幕', 'V-15': '幂等',
};

const STAGE_NAMES: Record<StageCode, string> = {
  PROBE: '读取视频',
  EXTRACT: '准备声音',
  LYRICS: '整理歌词',
  ACCOMPANIMENT: '生成伴奏',
  ALIGN: '对齐声音',
  ENCODE_MUX: '压缩视频',
  VALIDATE: '检查成品',
};

/** 日志只挑对排障有用的短字段，不把整个 data（含路径 / 会话信息）铺到界面。 */
const LOG_DATA_KEYS = [
  'reasonCode', 'userMessage', 'action', 'code', 'backend', 'encoder',
] as const;

function logLine(e: LogEntry): string {
  const time = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const head = `${time}  [${e.level}]  ${e.event}${e.stage ? `  (${e.stage})` : ''}`;
  if (!e.data) return head;
  const extra = LOG_DATA_KEYS.reduce<string[]>((acc, key) => {
    const value = e.data?.[key];
    if (typeof value !== 'string' && typeof value !== 'number') return acc;
    const text = String(value);
    acc.push(`${key}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
    return acc;
  }, []);
  return extra.length > 0 ? `${head}  ·  ${extra.join('  ·  ')}` : head;
}

function sourceLabel(source: string): string {
  return source === 'imported' ? '导入的官方伴奏' : '自动分离的伴奏';
}

/** L2 详情 / 日志抽屉：所有技术信息两步内可达，且带日志留痕。 */
export function DetailsDrawer({
  open,
  tab,
  onTabChange,
  onClose,
  job,
  progress,
  logs,
  report,
  backend,
  fallback,
  health,
  config,
  detailedMode,
  onDetailedModeChange,
  onPatch,
  onSelectAccompaniment,
  onExportLog,
  onRetryStage,
}: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useFocusTrap(open, panelRef);

  if (!open) return null;

  const stage = job?.stage ?? progress?.stage;
  const percent = Math.round(progress?.percent ?? job?.progress ?? 0);
  const ratio = report
    ? `输出约为源文件的 ${Math.round(report.compressionRatio * 100)}%`
    : '暂无压缩数据';

  return (
    <div className="drawer">
      <div className="drawer__backdrop" onClick={onClose} aria-hidden="true" />
      <aside ref={panelRef} className="drawer__panel" role="dialog" aria-modal="true" aria-label="详情与日志">
        <header className="drawer__head">
          <div
            className="drawer__tabs"
            role="tablist"
            aria-label="详情分类"
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const order: Array<'details' | 'logs' | 'settings'> = ['details', 'logs', 'settings'];
              const i = order.indexOf(tab);
              const next = e.key === 'Home' ? order[0]
                : e.key === 'End' ? order[2]
                : order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
              onTabChange(next);
            }}
          >
            <button type="button" role="tab" id="tab-details" aria-controls="panel-details"
              aria-selected={tab === 'details'} className="drawer__tab" onClick={() => onTabChange('details')}>详情</button>
            <button type="button" role="tab" id="tab-logs" aria-controls="panel-logs"
              aria-selected={tab === 'logs'} className="drawer__tab" onClick={() => onTabChange('logs')}>日志</button>
            <button type="button" role="tab" id="tab-settings" aria-controls="panel-settings"
              aria-selected={tab === 'settings'} className="drawer__tab" onClick={() => onTabChange('settings')}>更多设置</button>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onClose}
            aria-label="关闭详情"
          >
            关闭
          </button>
        </header>

        <div className="drawer__body">
          {tab === 'settings' ? (
            <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" tabIndex={0}>
            <MoreSettings
              config={config}
              onPatch={onPatch}
              detailedMode={detailedMode}
              onDetailedModeChange={onDetailedModeChange}
              onSelectAccompaniment={onSelectAccompaniment}
              backend={backend}
            />
            </div>
          ) : tab === 'logs' ? (
            <div role="tabpanel" id="panel-logs" aria-labelledby="tab-logs" tabIndex={0}>
            <section className="drawer__section">
              <div className="drawer__section-head">
                <h3 className="section-title">日志</h3>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={onExportLog}
                >
                  导出日志
                </button>
              </div>
              <div className="drawer__logs mono" role="log" aria-label="运行日志">
                {logs.length === 0 ? (
                  <div className="drawer__log-empty">暂时还没有日志</div>
                ) : (
                  logs.map((e, i) => (
                    <div key={`${e.ts}-${i}`} className={`drawer__log is-${e.level}`}>
                      {logLine(e)}
                    </div>
                  ))
                )}
              </div>
            </section>
                        </div>
          ) : (
            <div role="tabpanel" id="panel-details" aria-labelledby="tab-details" tabIndex={0}>
              <section className="drawer__section">
                <h3 className="section-title">当前进度</h3>
                <dl className="drawer__kv"><dt>阶段</dt><dd>{stage ? `${STAGE_NAMES[stage]}（${stage}）` : '尚未开始'}</dd></dl>
                <dl className="drawer__kv"><dt>完成度</dt><dd>{percent}%</dd></dl>
                {stage && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onRetryStage(stage)}
                  >
                    重跑这个阶段
                  </button>
                )}
                <div className="drawer__weights">
                  {(Object.keys(STAGE_WEIGHTS) as StageCode[]).map((s) => (
                    <span key={s} className={stage === s ? 'is-current' : ''} aria-current={stage === s ? 'step' : undefined}>
                      {STAGE_NAMES[s]} {STAGE_WEIGHTS[s]}%
                    </span>
                  ))}
                </div>
              </section>

              <section className="drawer__section">
                <h3 className="section-title">运行信息</h3>
                <dl className="drawer__kv"><dt>编码后端</dt><dd className="mono">{backend?.encodeEncoder ?? '待探测'}</dd></dl>
                <dl className="drawer__kv"><dt>分离后端</dt><dd className="mono">{backend?.separationBackend ?? '待探测'}</dd></dl>
                <dl className="drawer__kv"><dt>压缩比</dt><dd>{ratio}</dd></dl>
                <dl className="drawer__kv"><dt>伴奏来源</dt><dd>
                    {sourceLabel(report?.accompanimentSource ?? config.accompanimentSource)}
                  </dd></dl>
                <dl className="drawer__kv"><dt>压缩档</dt><dd>{COMPRESSION_PRESETS[config.compressionPreset].label}</dd></dl>
                {health && health.missing.length > 0 && (
                  <dl className="drawer__kv"><dt>缺少的能力</dt><dd className="mono">{health.missing.join('、')}</dd></dl>
                )}
              </section>

              {(backend?.degraded || fallback?.degraded) && (
                <section className="drawer__section">
                  <h3 className="section-title">降级原因</h3>
                  <p className="drawer__note">
                    <Semantic tone="warn">
                      {(fallback ?? backend)?.reasonText || '已改用较稳的方式继续'}
                    </Semantic>
                  </p>
                  <dl className="drawer__kv"><dt>原因码</dt><dd className="mono">{(fallback ?? backend)?.reasonCode ?? '-'}</dd></dl>
                </section>
              )}

              {job?.error && (
                <section className="drawer__section">
                  <h3 className="section-title">错误详情</h3>
                  <p className="drawer__note">
                    <Semantic tone="error">{job.error.userMessage}</Semantic>
                  </p>
                  <dl className="drawer__kv"><dt>错误码</dt><dd className="mono">{job.error.code}</dd></dl>
                  <dl className="drawer__kv"><dt>阶段</dt><dd className="mono">{job.error.stage}</dd></dl>
                </section>
              )}

              {report && (
                <section className="drawer__section">
                  <h3 className="section-title">校验报告</h3>
                  <div className="drawer__checks">
                    {report.checks.map((c) => (
                      <div key={c.code} className="drawer__check">
                        <Semantic
                          tone={c.passed ? 'success' : c.severity === 'warn' ? 'warn' : 'error'}
                        >
                          {CHECK_LABEL[c.code] ?? c.code} {c.passed ? '通过' : '未通过'}
                        </Semantic>
                        {!c.passed && (c.expected || c.actual) && (
                          <span className="drawer__note mono">
                            期望 {c.expected ?? '-'} · 实测 {c.actual ?? '-'}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
