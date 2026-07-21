# 认证平台架构说明

认证平台由网关层、业务服务层和基础设施层组成。

- API网关服务，日志服务名（serviceName）为 `api-gateway`，负责接收外部请求。
- 安全服务，日志服务名（serviceName）为 `security-service`，负责读取安全配置。
- API网关服务调用安全服务。
- 安全服务依赖 Redis生产集群，并从 Redis生产集群查询安全配置。
- Redis生产集群包含 redis-1、redis-2、redis-3 三个实例。
- redis-1 的 host=redis-1，ip=10.0.2.11，port=6379。
- redis-2 的 host=redis-2，ip=10.0.2.12，port=6379。
- redis-3 的 host=redis-3，ip=10.0.2.13，port=6379。

关系方向约定：调用者或消费者指向被依赖者；集群指向成员实例。以上信息来自部署清单，不允许推测未列出的实例。
