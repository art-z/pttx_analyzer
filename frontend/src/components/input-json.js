import {
  buildComponentDataPayload,
  componentToDataPayload,
} from './model-data.js'
import { isIterableRepeatComponent } from './container-catalog.js'

export {
  buildComponentDataPayload,
  componentToDataPayload,
  applyModelData,
  applyModelDataToComponent,
  applyModelDataToSlide,
  applyTableDataToElement,
  applyChartDataToElement,
  applyDiagramDataToElement,
  applyContainerDataToInstance,
  tableMatrixToDataPayload,
  tableDataToMatrix,
  ITERABLE_PAYLOAD_KEYS,
} from './model-data.js'

export function buildComponentInputJson(report, component, previewContext = {}) {
  return buildComponentDataPayload(report, component, previewContext.instance || null)
}

export function formatComponentInputJson(input) {
  return JSON.stringify(input, null, 2)
}

export function componentInputJsonCaption(component) {
  if (component.kind === 'table') {
    return 'Параметры таблицы: row_count, col_count, columns + rows. Preview перестраивает grid и data.'
  }
  if (component.kind === 'chart') {
    return 'Только данные графика: categories + series. applyModelData() подставит values в chart-render.'
  }
  if (component.kind === 'diagram') {
    return 'Только данные диаграммы: nodes[].label. applyModelData() обновит preview_texts.'
  }
  if (component.kind === 'slide_title') {
    return 'Параметры заголовка: word_count/text из дефолтной фразы. Preview подставит текст в title slot.'
  }
  if (component.kind === 'slide_description') {
    return 'Параметры описания: word_count/text для абзаца под заголовком. Preview подставит текст в body/description slot.'
  }
  if (component.kind === 'slide_image') {
    return 'Параметры hero-изображения: asset, fill_mode, placement_id. Preview изолирует title + description + image area.'
  }
  if (component.kind === 'paginator') {
    return 'Параметры пагинатора: page_count, active_index, placement_id. Preview перерисует dots на слайде.'
  }
  if (component.kind === 'metric') {
    return 'KPI data: каждый metrics[] содержит числовой value, необязательный unit и обязательный description. heading/body для KPI не используются.'
  }
  if (isIterableRepeatComponent(component)) {
    return 'Repeat data: item_count равен длине items; каждый items[].fields использует heading + body. Роли конкретного шаблона сопоставляются автоматически.'
  }
  return 'Только контент контейнера: semantic fields. applyModelData() обновит slots экземпляра.'
}

export function componentInputJsonTitle() {
  return 'Данные для заполнения'
}
