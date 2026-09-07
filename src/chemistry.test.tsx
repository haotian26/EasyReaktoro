import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChemicalFormula, ELEMENTS, parseFormula } from './chemistry'

describe('shared chemistry UI', () => {
  it('contains all 118 elements with bilingual names', () => {
    expect(ELEMENTS).toHaveLength(118)
    expect(ELEMENTS.find(x => x.symbol === 'O')).toMatchObject({ zh:'氧', en:'Oxygen' })
    expect(ELEMENTS.filter(x => x.series === 'lanthanide')).toHaveLength(15)
    expect(ELEMENTS.filter(x => x.series === 'actinide')).toHaveLength(15)
  })

  it('renders subscripts and Reaktoro-style charge without unsafe HTML', () => {
    expect(parseFormula('SO4-2')).toMatchObject({ charge:'2⁻' })
    const html = renderToStaticMarkup(<ChemicalFormula value="CaCO3" />)
    expect(html).toContain('<sub>3</sub>')
    expect(html).not.toContain('dangerouslySetInnerHTML')
  })
  it('accepts pasted Unicode and explicit charge without turning hydrate coefficients into subscripts', () => {
    expect(parseFormula('SO₄²⁻(aq)')).toMatchObject({charge:'2⁻',phase:'(aq)'})
    expect(parseFormula('SO4^2-')).toMatchObject({charge:'2⁻'})
    expect(parseFormula('CuSO4·5H2O').tokens.find(x=>x.text==='5')?.sub).toBe(false)
    expect(renderToStaticMarkup(<ChemicalFormula value="<script>alert(1)</script>"/>)).not.toContain('<script>')
  })
})
