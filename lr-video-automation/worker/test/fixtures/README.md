# ダミーMP4 fixture

`dummy-video.mp4` は黒一色・無音・16×16px・0.1秒のテスト専用動画です。実動画・個人情報は含みません。

再生成（ffmpegがある開発端末のみ）:

```sh
ffmpeg -y -f lavfi -i color=c=black:s=16x16:d=0.1:r=10 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart test/fixtures/dummy-video.mp4
```
