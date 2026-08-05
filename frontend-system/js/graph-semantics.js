const EVIDENCE_KINDS = new Set(["LogEvent", "Trace", "Exception", "Window", "Metric"]);

const normalize = (value) => String(value || "").trim().toLocaleLowerCase();

const validHypothesis = (hypothesis) => (
  hypothesis
  && Array.isArray(hypothesis.chain)
  && hypothesis.chain.length > 0
);

export function filterIncidentGraph(graph, includeEvidence) {
  if (includeEvidence) return graph;
  const nodes = (graph.nodes || []).filter((node) => !EVIDENCE_KINDS.has(node.kind));
  const names = new Set(nodes.map((node) => node.name));
  return {
    ...graph,
    nodes,
    edges: (graph.edges || []).filter((edge) => names.has(edge.source) && names.has(edge.target)),
  };
}

export function buildIncidentSemantics(hypotheses = [], llmDecision = {}, visibleNames = null) {
  const candidates = hypotheses.filter(validHypothesis);
  const modelSource = normalize(llmDecision.source);
  const isModelDecision = Boolean(modelSource && modelSource !== "fallback");
  let selected = null;

  if (isModelDecision) {
    const selectedName = normalize(llmDecision.selected_candidate);
    selected = candidates.find((item) => normalize(item.candidate) === selectedName) || null;
    if (!selected && Number(llmDecision.selected_candidate_rank) > 0) {
      selected = candidates.find((item) => Number(item.rank) === Number(llmDecision.selected_candidate_rank)) || null;
    }
  }

  const fallback = [...candidates].sort((left, right) => Number(left.rank || 0) - Number(right.rank || 0))[0] || null;
  const primaryCandidate = selected || fallback;
  const primary = primaryCandidate
    ? { ...primaryCandidate, source: selected ? "llm" : "algorithm" }
    : null;
  const chain = primary?.chain || [];
  const displayItems = Array.isArray(llmDecision.display_chain) ? llmDecision.display_chain : [];
  const proposedDisplay = new Map(
    displayItems
      .filter((item) => item && typeof item === "object")
      .map((item) => [String(item.node || ""), item]),
  );
  const completeDisplay = chain.length > 0 && chain.every((name) => proposedDisplay.has(String(name)));
  const displayByNode = Object.fromEntries(
    (completeDisplay ? chain : []).map((name) => {
      const item = proposedDisplay.get(String(name));
      return [String(name), {
        label: String(item.label || item.node || ""),
        explanation: String(item.explanation || ""),
        stage: String(item.stage || ""),
      }];
    }),
  );
  const alternatives = candidates.filter((item) => item !== primaryCandidate);
  const warnings = [];
  const overlays = [];
  const seenEdges = new Set();
  const candidateRanks = Object.fromEntries(
    candidates.map((item) => [String(item.candidate || item.chain[0]), Number(item.rank || 0)]),
  );

  const appendChain = (hypothesis, variant) => {
    const missing = visibleNames
      ? hypothesis.chain.filter((name) => !visibleNames.has(name))
      : [];
    if (missing.length) {
      warnings.push(`传播链缺少图节点：${missing.join("、")}`);
    }
    for (let index = 0; index < hypothesis.chain.length - 1; index += 1) {
      const source = hypothesis.chain[index];
      const target = hypothesis.chain[index + 1];
      if (visibleNames && (!visibleNames.has(source) || !visibleNames.has(target))) continue;
      const edgeKey = `${variant}\u0000${source}\u0000${target}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      overlays.push({
        source,
        target,
        variant,
        rank: Number(hypothesis.rank || 0),
      });
    }
  };

  if (primary) appendChain(primary, primary.source === "llm" ? "model" : "algorithm");
  alternatives.forEach((item) => appendChain(item, "alternative"));

  return {
    primary,
    alternatives,
    overlays,
    candidateRanks,
    displayByNode,
    start: chain[0] || "",
    end: chain.at(-1) || "",
    warnings: [...new Set(warnings)],
  };
}
