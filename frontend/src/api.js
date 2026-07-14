import axios from 'axios';

export const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000';

const http = axios.create({
  baseURL: API_BASE,
  timeout: 20 * 60 * 1000
});

function normalizeError(error) {
  const data = error?.response?.data;
  if (typeof data?.detail === 'string') return data.detail;
  if (typeof data?.message === 'string') return data.message;
  if (typeof data === 'string') return data;
  return error?.message || String(error);
}

export function normalizeGraphPayload(payload) {
  return {
    nodes: Array.isArray(payload?.nodes) ? payload.nodes : [],
    edges: Array.isArray(payload?.edges) ? payload.edges : [],
    warnings: Array.isArray(payload?.warnings) ? payload.warnings : []
  };
}

export async function fetchGraph(limit = 5000) {
  try {
    const { data } = await http.get('/api/graph', { params: { limit } });
    return normalizeGraphPayload(data);
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function importKnowledgeFile(file) {
  try {
    const form = new FormData();
    form.append('file', file);
    const { data } = await http.post('/api/import', form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return data;
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

export async function clearKnowledgeGraph() {
  try {
    const { data } = await http.post('/api/clear');
    return data;
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}
