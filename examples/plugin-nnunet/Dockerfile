# nnU-Net 系 plugin 映像：同一個映像跑 plugin（預設）或遠端推論服務（command 換成 server:app）。
# 權重不在映像裡：TotalSegmentator 首次推論會下載到 TOTALSEG_HOME_DIR（掛 volume 才不會每次重抓）；
# 自訓練 nnU-Net 權重掛到 NNUNET_RESULTS。
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime
WORKDIR /app
# SDK 與 geom 從 repo 複製進來（build context 是 examples/plugin-nnunet，所以由 compose 先 build wheel 或改用 pip 安裝發佈版）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY engine.py plugin.py server.py ./
COPY ui/dist ./ui/dist
ENV RTGAIA_PLUGIN_ARTIFACTS=/data/artifacts RTGAIA_PLUGIN_DATA=/data \
    TOTALSEG_HOME_DIR=/models/totalseg NNUNET_RESULTS=/models/nnunet \
    NNUNET_RAW=/tmp/raw NNUNET_PREPROCESSED=/tmp/pre
EXPOSE 8702 8710
CMD ["uvicorn", "plugin:app", "--host", "0.0.0.0", "--port", "8702"]
