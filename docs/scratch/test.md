
这是一个**正常运行的Kubernetes集群，当前节点是集群的Master控制平面节点**，状态如下：

### 集群整体状态
集群共4个节点，所有节点均正常就绪，已稳定运行24天，Kubernetes版本为 `v1.28.2`：
```
NAME        STATUS   ROLES                  AGE   VERSION
master      Ready    control-plane,master   24d   v1.28.2
slave-166   Ready    <none>                 24d   v1.28.2
slave-167   Ready    <none>                 24d   v1.28.2
slave-168   Ready    <none>                 24d   v1.28.2
```

### 当前Master节点运行的核心服务
所有核心组件均正常工作：
- K8s核心组件：`kubelet`、`kube-proxy`、`kube-apiserver` 都处于运行状态
- 容器运行时：`containerd`、`dockerd` 也都正常运行

从HDFS存储统计结果来看，当前HDFS总共有约 **10.5GB** 的数据，绝大多数都存储在HBase的默认数据目录中，具体各目录占用情况：
| 目录       | 占用总空间 |
| ---------- | ---------- |
| `/hbase`   | 10.5GB     |
| `/tmp`     | 26.4MB     |
| `/flink`   | 1.0MB      |
| `/spark`   | 720.7KB    |
| `/user`    | 143.7KB    |
| `/test_dir`| 无数据     |

如果需要查看某个目录下具体的文件列表，可以执行类似以下命令查看，例如查看`/hbase`目录下内容：
```bash
/opt/module/hadoop/bin/hdfs dfs -ls /hbase
```