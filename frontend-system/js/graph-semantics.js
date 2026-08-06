const EVIDENCE_KINDS = new Set(["LogEvent", "Trace", "Exception", "Window", "Metric"]);
const INTERNAL_KINDS = new Set(["Incident", "RCAHypothesis", "Trace", "UnresolvedDependency"]);

const normalize = (value) => String(value || "").trim().toLocaleLowerCase();

const validHypothesis = (hypothesis) => (
  hypothesis
  && Array.isArray(hypothesis.chain)
  && hypothesis.chain.length > 0
);

export function filterIncidentGraph(graph, includeEvidence) {
  const nodes = (graph.nodes || []).filter((node) => {
    const name = String(node?.name || "");
    if (INTERNAL_KINDS.has(node.kind)) return false;
    if (/^(?:Incident|RCAHypothesis|RootCandidate|Trace):/i.test(name)) return false;
    return includeEvidence || !EVIDENCE_KINDS.has(node.kind);
  });
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
  const displayItems = Array.isArray(llmDecision.propagation_path)
    ? llmDecision.propagation_path
    : Array.isArray(llmDecision.display_chain) ? llmDecision.display_chain : [];
  const modelChain = displayItems
    .filter((item) => item && typeof item === "object" && String(item.node || "").trim())
    .map((item) => String(item.node));
  let selected = null;

  if (isModelDecision) {
    const selectedName = normalize(llmDecision.selected_candidate);
    selected = candidates.find((item) => normalize(item.candidate) === selectedName) || null;
    if (!selected && Number(llmDecision.selected_candidate_rank) > 0) {
      selected = candidates.find((item) => Number(item.rank) === Number(llmDecision.selected_candidate_rank)) || null;
    }
  }

  const fallback = [...candidates].sort((left, right) => Number(left.rank || 0) - Number(right.rank || 0))[0] || null;
  const modelPrimary = isModelDecision && llmDecision.selected_node_id && modelChain.length
    ? {
      candidate: String(llmDecision.selected_candidate || modelChain[0]),
      chain: modelChain,
      confidence: llmDecision.confidence,
      fault_mode: llmDecision.selected_fault_mode,
      rank: 0,
      source: "llm",
    }
    : null;
  const primaryCandidate = modelPrimary || selected || fallback;
  const primary = primaryCandidate
    ? { ...primaryCandidate, source: modelPrimary || selected ? "llm" : "algorithm" }
    : null;
  const chain = primary?.chain || [];
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
  // The detail view explains one final decision. Alternative hypotheses stay
  // persisted for audit, but rendering them together obscures the chosen path.
  const alternatives = [];
  const warnings = [];
  const overlays = [];
  const seenEdges = new Set();
  const candidateRanks = primary?.source === "algorithm" && primary?.rank
    ? { [String(primary.candidate || primary.chain[0])]: Number(primary.rank) }
    : {};

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
