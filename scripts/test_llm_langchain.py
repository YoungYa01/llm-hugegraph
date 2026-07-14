from app.analyzer import LLMAnalyzer

if __name__ == "__main__":
    analyzer = LLMAnalyzer()
    result = analyzer.analyze_architecture("订单服务调用库存服务，订单服务读写订单数据库。")
    print(result)
