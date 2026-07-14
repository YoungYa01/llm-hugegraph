import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearKnowledgeGraph, fetchGraph, importKnowledgeFile, normalizeGraphPayload } from './api.js';
import GraphCanvas from './GraphCanvas.jsx';
import { getNodeId, getNodeKind, getNodeName, getRelationType, safeString, topologicalSlice } from './graphTheme.js';

const QUERY_LIMIT = 5000;
const RENDER_LIMIT = 1400;

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function DetailOverlay({ selection, onClose }) {
  if (!selection) return null;
  const item = selection.item;
  const isNode = selection.type === 'node';
  return (
    <div className="detail-popover">
      <button type="button" className="popover-close" onClick={onClose}>×</button>
      <span className="popover-kicker">{isNode ? getNodeKind(item) : getRelationType(item)}</span>
      <h3>{isNode ? getNodeName(item) : `${safeString(item.source)} → ${safeString(item.target)}`}</h3>
      {isNode ? (
        <>
          <p>{item.description || '暂无描述'}</p>
          <dl>
            <dt>ID</dt><dd>{getNodeId(item)}</dd>
            {item.layer && <><dt>层级</dt><dd>{item.layer}</dd></>}
          </dl>
        </>
      ) : (
        <>
          <p>{item.description || '暂无描述'}</p>
          <dl>
            <dt>Source</dt><dd>{safeString(item.source)}</dd>
            <dt>Target</dt><dd>{safeString(item.target)}</dd>
          </dl>
        </>
      )}
    </div>
  );
}

export default function App() {
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const [graph, setGraph] = useState({ nodes: [], edges: [], warnings: [] });
  const [busy, setBusy] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [message, setMessage] = useState('正在连接图谱服务...');
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('—');
  const [selection, setSelection] = useState(null);
  const [sceneInfo, setSceneInfo] = useState({ scale: 1 });

  const visibleGraph = useMemo(() => {
    return topologicalSlice(graph, RENDER_LIMIT);
  }, [graph]);

  const loadGraph = useCallback(async () => {
    setBusy(true);
    setError('');
    setMessage('正在刷新知识图谱...');
    try {
      const data = await fetchGraph(QUERY_LIMIT);
      setGraph(data);
      setUpdatedAt(nowTime());
      setMessage(data.nodes.length ? `已加载 ${data.nodes.length} 个节点 / ${data.edges.length} 条关系` : '当前图谱为空');
      window.setTimeout(() => canvasRef.current?.fit(), 120);
    } catch (err) {
      setError(err.message);
      setMessage('图谱读取失败');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  async function handleImport(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    setSelection(null);
    setMessage(`正在导入 ${file.name}，抽取和写图可能需要一些时间...`);
    try {
      const result = await importKnowledgeFile(file);
      const nextGraph = result.graph ? normalizeGraphPayload(result.graph) : await fetchGraph(QUERY_LIMIT);
      setGraph(nextGraph);
      setUpdatedAt(nowTime());
      setMessage(`导入完成：${nextGraph.nodes.length} 个节点 / ${nextGraph.edges.length} 条关系`);
      window.setTimeout(() => canvasRef.current?.fit(), 220);
    } catch (err) {
      setError(err.message);
      setMessage('导入失败');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleClear() {
    const ok = window.confirm('确定清空当前 LogSys demo 图谱？');
    if (!ok) return;
    setBusy(true);
    setError('');
    setSelection(null);
    setMessage('正在清空图谱...');
    try {
      await clearKnowledgeGraph();
      setGraph({ nodes: [], edges: [], warnings: [] });
      setUpdatedAt(nowTime());
      setMessage('图谱已清空');
    } catch (err) {
      setError(err.message);
      setMessage('清空失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <div>
            <strong>LogSys Knowledge Graph</strong>
            <em>{visibleGraph.sliced ? `展示核心 ${visibleGraph.nodes.length} 个节点` : '系统架构关系图谱'}</em>
          </div>
        </div>

        <div className="topbar-actions">
          <label className={`primary-button ${busy ? 'disabled' : ''}`}>
            <input
              ref={fileInputRef}
              disabled={busy}
              type="file"
              accept=".txt,.md,.yaml,.yml"
              onChange={event => handleImport(event.target.files?.[0])}
            />
            上传文件
          </label>
          <button type="button" disabled={busy} onClick={loadGraph}>刷新</button>
          <button type="button" disabled={busy} className="danger-button" onClick={handleClear}>清空</button>
        </div>
      </header>

      <main className="graph-stage">
        <GraphCanvas
          ref={canvasRef}
          graph={visibleGraph}
          onBusyChange={setLayoutBusy}
          onSelectionChange={setSelection}
          onSceneInfo={setSceneInfo}
        />

        <div className="scene-status">
          <span className={`pulse ${busy || layoutBusy ? 'active' : ''}`} />
          <b>{message}</b>
          <i>最后更新 {updatedAt}</i>
          {visibleGraph.sliced && <i>大图模式：已自动保留核心拓扑</i>}
          <i>缩放 {Math.round((sceneInfo.scale || 1) * 100)}%</i>
        </div>

        <DetailOverlay selection={selection} onClose={() => { setSelection(null); canvasRef.current?.clearSelection(); }} />

        {error && <div className="toast error-toast">{error}</div>}
        {graph.warnings?.length > 0 && <div className="toast warn-toast">{graph.warnings.join('；')}</div>}
      </main>
    </div>
  );
}
