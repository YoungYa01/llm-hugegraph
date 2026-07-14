import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from app.analyzer import LLMAnalyzer, SYSTEM_PROMPT

assert '{"services"' in SYSTEM_PROMPT
analyzer = LLMAnalyzer()
parsed = analyzer._parse_json_lenient('```json\n{"services":[{"name":"订单服务"}],"calls":[]}\n```')
normalized = analyzer._normalize_graph(parsed).model_dump()
assert normalized['services'][0]['name'] == '订单服务'
print('static_check ok')
