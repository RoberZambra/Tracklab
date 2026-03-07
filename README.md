# EnduranceIQ – Comparador de Treinos PWA

## 🚀 Como executar

### Opção 1: Servidor Local (recomendado)
```bash
# Python 3
python -m http.server 8080

# Node.js (npx)
npx serve .

# PHP
php -S localhost:8080
```
Depois abra: `http://localhost:8080`

### Opção 2: VS Code Live Server
Instale a extensão "Live Server" e clique em "Go Live".

> ⚠️ **Importante**: Abra sempre via servidor HTTP (não direto pelo sistema de arquivos). O Service Worker e o Leaflet precisam de HTTP para funcionar corretamente.

---

## 📁 Estrutura de Arquivos

```
endurance-compare/
├── index.html            # App principal (PWA)
├── app.js                # Lógica: parser GPX/TCX, gráficos, mapa
├── sw.js                 # Service Worker (offline)
├── manifest.json         # PWA Manifest (instalável no celular)
├── sample1_corrida.gpx   # Arquivo GPX de exemplo – Corrida
└── sample2_ciclismo.gpx  # Arquivo GPX de exemplo – Ciclismo
```

---

## ✅ Funcionalidades

| Feature | Status |
|---|---|
| Upload drag & drop múltiplos arquivos | ✅ |
| Parser GPX (XML nativo) | ✅ |
| Parser TCX (XML nativo) | ✅ |
| Dashboard comparativo com tabela | ✅ |
| KPI cards com delta % entre treinos | ✅ |
| Gráfico Altitude × Distância | ✅ |
| Gráfico Velocidade × Distância | ✅ |
| Gráfico Frequência Cardíaca × Distância | ✅ |
| Mapa Leaflet com rotas coloridas | ✅ |
| Marcadores de início/fim no mapa | ✅ |
| Modo Escuro / Claro | ✅ |
| Botão "Convidar Amigo" (Web Share API) | ✅ |
| Fallback clipboard para share | ✅ |
| Service Worker (offline) | ✅ |
| manifest.json (instalável) | ✅ |
| Mobile First / Responsivo | ✅ |
| Métricas: Distância, Duração, Pace, Vel. Máx., Elevação, Calorias, FC | ✅ |

---

## 📐 Métricas Calculadas

- **Distância**: Fórmula de Haversine entre pontos consecutivos
- **Duração**: Delta de tempo entre primeiro e último ponto
- **Pace Médio** (min/km): `60 / velocidade_média_kmh`
- **Velocidade Máxima**: Pico entre pontos consecutivos (outliers cortados em 80 km/h)
- **Ganho de Elevação**: Soma de deltas positivos de altitude
- **Frequência Cardíaca**: Média e máximo dos dados HR nos trackpoints
- **Calorias**: Estimativa via fórmula MET simplificada

---

## 🎨 Stack Técnico

- **HTML5** + **Tailwind CSS** (CDN)
- **JavaScript Puro** (ES2020+, sem frameworks)
- **Chart.js 4.4** – gráficos interativos
- **Leaflet 1.9** + **OpenStreetMap** – mapa de trajetos
- **DOMParser** – leitura nativa de XML (GPX/TCX)
- **Web Share API** – compartilhamento nativo
- **Service Worker** + **Cache API** – suporte offline
- **Web App Manifest** – instalação como app

---

## 📱 Instalar como App

1. Abra no Chrome/Safari Mobile
2. Toque em "Compartilhar" → "Adicionar à tela inicial"
3. O app abre em tela cheia sem barra do navegador

---

## 🧪 Testando com os arquivos de exemplo

Arraste os dois arquivos GPX incluídos:
- `sample1_corrida.gpx` – Corrida no Parque Ibirapuera (SP)
- `sample2_ciclismo.gpx` – Ciclismo no Parque Ibirapuera (SP)

Você verá os dois trajetos sobrepostos no mapa e nos gráficos.
