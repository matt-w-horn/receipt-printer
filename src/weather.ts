// Weather context for the daily art prompt, via the Google Weather API
// (keyed by GEMINI_KEY — it's a Google Cloud API key). Weather is garnish for
// the art, not a dependency: the caller degrades gracefully when this throws.

export interface WeatherData {
  current: number;
  feels_like: number;
  high: number;
  low: number;
  humidity: unknown;
  wind: number;
  uv: unknown;
  rain_chance: number;
  code: string;
  forecast: string;
  currentConditions: string;
}

export function getDeepWeather(
  lat: string,
  lon: string | null,
  apiKey: string,
): WeatherData {
  const currentUrl = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lon}&unitsSystem=IMPERIAL`;
  const currentRes = UrlFetchApp.fetch(currentUrl, { muteHttpExceptions: false });
  const currentData = JSON.parse(currentRes.getContentText());

  const forecastUrl = `https://weather.googleapis.com/v1/forecast/hours:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lon}&hours=24&unitsSystem=IMPERIAL`;
  const forecastRes = UrlFetchApp.fetch(forecastUrl, { muteHttpExceptions: false });
  const forecastData = JSON.parse(forecastRes.getContentText());

  let maxTemp = -100,
    minTemp = 200,
    maxRain = 0;
  if (forecastData.forecastHours) {
    forecastData.forecastHours.forEach((h: any) => {
      const t = h.temperature.degrees;
      const pr = h.precipitation?.probability?.percent || 0;
      if (t > maxTemp) maxTemp = t;
      if (t < minTemp) minTemp = t;
      if (pr > maxRain) maxRain = pr;
    });
  } else {
    maxTemp = currentData.temperature.degrees;
    minTemp = currentData.temperature.degrees;
  }

  return {
    current: Math.round(currentData.temperature.degrees),
    feels_like: Math.round(currentData.feelsLikeTemperature.degrees),
    high: Math.round(maxTemp),
    low: Math.round(minTemp),
    humidity: currentData.relativeHumidity,
    wind: Math.round(currentData.wind.speed.value),
    uv: currentData.uvIndex,
    rain_chance: maxRain,
    code: currentData.weatherCondition.description.text,
    forecast: forecastRes.getContentText(),
    currentConditions: currentRes.getContentText(),
  };
}
