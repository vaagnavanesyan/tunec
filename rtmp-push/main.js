const { spawn } = require("child_process");

const serverUrl = "rtmp://rtmp-lb-b.dth.rutube.ru/live_push"; // Замените на ваш адрес сервера
const streamKey =
  "e43529e4c21aba9e93993c24e5939d24?sinfo=4nO7P0U0y6az8HGRr8k1InXjnxVpkY68"; // Замените на ваш ключ потока
const rtmpUrl = `${serverUrl}/${streamKey}`;

const inputSource = "input.webm"; // Или 'video="USB Webcam"` для камеры (Windows), или экран/другое

const ffmpeg = spawn(
  "ffmpeg",
  [
    "-re", // Чтение в реальном времени
    "-i",
    inputSource, // Источник: файл, камера, экран и т.д.
    "-c:v",
    "libx264", // Видео-кодек
    "-preset",
    "veryfast", // Быстрое кодирование
    "-maxrate",
    "2500k", // Максимальный битрейт
    "-bufsize",
    "5000k", // Буфер
    "-pix_fmt",
    "yuv420p", // Формат пикселей
    "-g",
    "50", // GOP size
    "-c:a",
    "aac", // Аудио-кодек
    "-b:a",
    "160k", // Аудио-битрейт
    "-ar",
    "44100", // Частота аудио
    "-f",
    "flv", // Формат вывода для RTMP
    rtmpUrl,
  ],
  { stdio: ["inherit", "inherit", "inherit"] }
); // Логи в консоль

ffmpeg.on("close", (code) => {
  console.log(`Процесс завершён с кодом ${code}`);
});

ffmpeg.on("error", (err) => {
  console.error("Ошибка:", err.message);
});
